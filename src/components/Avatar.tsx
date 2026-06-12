type AvatarUser = {
	username?: string | null;
	name: string | null;
	profile_picture_url: string | null;
};

type Props = { user: AvatarUser | null };

export function Avatar({ user }: Props) {
	const initial = (user?.username ?? user?.name ?? "?").slice(0, 1).toUpperCase();
	const url = user?.profile_picture_url;
	const isAbsolute = !!url && /^https:\/\//i.test(url);
	if (isAbsolute) {
		return (
			<img class="avatar" src={url} alt="" loading="lazy" decoding="async" width={18} height={18} />
		);
	}
	return <div class="avatar">{initial}</div>;
}
