// Pixel sizes for image attachments, so the frontend can reserve an image's box before it loads
// instead of shifting the layout when it does.
//
// HackerOne's attachment record carries no dimensions and neither does the S3 object behind the
// presigned URL, so the size is read out of the file's own header: one ranged GET for the first
// chunk of the file, parsed by `imagesize`. The result goes in the `attachment_dimensions` table
// keyed on the attachment id, and a probe that fails stores a row with no size so the attachment
// isn't fetched again.

use std::collections::HashSet;

use crate::error::AppResult;
use crate::hackerone::{Activity, Attachment, ImageDimensions, ReportDetail};
use crate::local_db::ReportStore;

// Enough to reach the size header of every format `imagesize` reads, including a JPEG with a
// bulky EXIF or ICC preamble ahead of its SOF marker.
const PROBE_BYTES: usize = 256 * 1024;

// Matches the frontend's test for rendering an attachment as an image. The API's content type
// is not reliable (a PDF has been seen labelled image/svg+xml), which is one reason a probe can
// fail.
pub fn is_image(a: &Attachment) -> bool {
    a.content_type
        .as_deref()
        .is_some_and(|t| t.starts_with("image/"))
}

pub fn image_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    let size = imagesize::blob_size(bytes).ok()?;
    Some(ImageDimensions {
        width: u32::try_from(size.width).ok()?,
        height: u32::try_from(size.height).ok()?,
    })
}

pub fn of_activity_mut(a: &mut Activity) -> &mut [Attachment] {
    match a {
        Activity::Comment { attachments, .. } => attachments,
        _ => &mut [],
    }
}

fn of_activity(a: &Activity) -> &[Attachment] {
    match a {
        Activity::Comment { attachments, .. } => attachments,
        _ => &[],
    }
}

// Every attachment on a report: the report's own plus each comment's.
pub fn of_detail_mut(detail: &mut ReportDetail) -> Vec<&mut Attachment> {
    let mut all = detail.attachments.iter_mut().collect::<Vec<_>>();
    all.extend(detail.activities.iter_mut().flat_map(of_activity_mut));
    all
}

fn of_detail(detail: &ReportDetail) -> impl Iterator<Item = &Attachment> {
    detail
        .attachments
        .iter()
        .chain(detail.activities.iter().flat_map(of_activity))
}

// Fill in the stored size of every attachment on a report that has one.
pub fn apply_dimensions(store: &dyn ReportStore, detail: &mut ReportDetail) -> AppResult<()> {
    let attachments = of_detail_mut(detail);
    let ids = attachments
        .iter()
        .map(|a| a.id.as_str())
        .collect::<Vec<_>>();
    let known = store.attachment_dimensions(&ids)?;
    for a in attachments {
        a.dimensions = known.get(&a.id).copied().flatten();
    }
    Ok(())
}

// Probe each image attachment on the report that hasn't been probed before, and record what was
// found. Runs right after the detail is stored, while the presigned URLs are fresh. Best-effort
// throughout: nothing here can fail the sync or the report fetch.
pub async fn probe_images(store: &dyn ReportStore, detail: &ReportDetail) {
    let mut seen = HashSet::new();
    let candidates = of_detail(detail)
        .filter(|a| is_image(a) && seen.insert(a.id.clone()))
        .map(|a| (a.id.clone(), a.expiring_url.clone()))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return;
    }
    let ids = candidates
        .iter()
        .map(|(id, _)| id.as_str())
        .collect::<Vec<_>>();
    let Ok(known) = store.attachment_dimensions(&ids) else {
        return;
    };

    let mut set = tokio::task::JoinSet::new();
    for (id, url) in candidates {
        if known.contains_key(&id) {
            continue;
        }
        set.spawn(async move { (id, probe_url(&url).await) });
    }
    while let Some(Ok((id, outcome))) = set.join_next().await {
        if let Some(dimensions) = outcome {
            let _ = store.set_attachment_dimensions(&id, dimensions);
        }
    }
}

// Outer `None` is a transport failure with nothing to record, so the next sync tries again.
// Inner `None` is a definitive answer: the URL was rejected or the bytes aren't an image the
// parser knows, and that's recorded so the attachment is never fetched again.
async fn probe_url(url: &str) -> Option<Option<ImageDimensions>> {
    let mut res = reqwest::Client::new()
        .get(url)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_BYTES - 1),
        )
        .send()
        .await
        .ok()?;
    let status = res.status();
    if status.is_server_error() {
        return None;
    }
    if !status.is_success() {
        return Some(None);
    }
    // The range header is advisory, so cap the read ourselves rather than trust the server to.
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = res.chunk().await {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= PROBE_BYTES {
            break;
        }
    }
    Some(image_dimensions(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The 8-byte PNG signature followed by an IHDR chunk declaring 822 × 213.
    const PNG_HEADER: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D',
        b'R', 0x00, 0x00, 0x03, 0x36, 0x00, 0x00, 0x00, 0xd5, 0x08, 0x02, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn reads_the_size_out_of_a_png_header() {
        assert_eq!(
            image_dimensions(PNG_HEADER),
            Some(ImageDimensions {
                width: 822,
                height: 213
            })
        );
    }

    #[test]
    fn bytes_that_are_not_an_image_have_no_size() {
        assert_eq!(image_dimensions(b"%PDF-1.7 not an image"), None);
        assert_eq!(image_dimensions(b""), None);
    }

    #[test]
    fn only_image_content_types_are_candidates() {
        let a = |content_type: Option<&str>| Attachment {
            id: "1".into(),
            file_name: "f".into(),
            content_type: content_type.map(String::from),
            file_size: None,
            expiring_url: "https://example.com/f".into(),
            dimensions: None,
        };
        assert!(is_image(&a(Some("image/png"))));
        assert!(is_image(&a(Some("image/svg+xml"))));
        assert!(!is_image(&a(Some("application/pdf"))));
        assert!(!is_image(&a(None)));
    }
}
