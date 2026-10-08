const MAX_NAME = 32;

/** herdr agent names must match `[a-z][a-z0-9_-]{0,31}`. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function slug(text: string): string {
	const s = text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	return /^[a-z]/.test(s) ? s : `p${s}`;
}

/** `<project>-<n>` with the smallest free n, within herdr's length limit. */
export function nextAgentName(projectName: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base = slug(projectName);
	for (let n = 1; ; n++) {
		const suffix = `-${n}`;
		const name = base.slice(0, MAX_NAME - suffix.length).replace(/-+$/, '') + suffix;
		if (!used.has(name)) {
			return name;
		}
	}
}
