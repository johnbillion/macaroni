type AvatarUser = {
	username?: string | null;
	name: string | null;
	profile_picture_url: string | null;
};

type Props = { user: AvatarUser | null; size?: "sm" | "md" };

export function Avatar({ user, size = "sm" }: Props) {
	const cls = `avatar avatar-${size}`;
	const initial = (user?.name ?? user?.username ?? "?").slice(0, 1).toUpperCase();
	const url = user?.profile_picture_url;
	const isAbsolute = !!url && /^https:\/\//i.test(url);
	if (isAbsolute) {
		return (
			<img
				class={cls}
				src={url}
				alt=""
				width={size === "sm" ? 18 : 22}
				height={size === "sm" ? 18 : 22}
			/>
		);
	}
	return <div class={cls}>{initial}</div>;
}
