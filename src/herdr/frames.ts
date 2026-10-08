// The newline-delimited JSON protocol of `herdr terminal session control`.
// Shapes confirmed against herdr 0.9.3; they are not part of `herdr api schema`.

export type StreamRecord =
	| { type: 'frame'; bytes: Buffer; full: boolean; seq: number; width: number; height: number }
	| { type: 'closed'; reason: string };

/** Splits a stream of chunks into complete lines. */
export class LineSplitter {
	private rest = '';

	push(chunk: string): string[] {
		const parts = (this.rest + chunk).split('\n');
		this.rest = parts.pop() ?? '';
		return parts.filter(line => line.trim() !== '');
	}
}

/** Returns undefined for lines that are not a record Paddock understands. */
export function parseStreamLine(line: string): StreamRecord | undefined {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof json !== 'object' || json === null) {
		return undefined;
	}
	const r = json as Record<string, unknown>;
	if (r.type === 'terminal.frame' && typeof r.bytes === 'string') {
		return {
			type: 'frame',
			bytes: Buffer.from(r.bytes, 'base64'),
			full: r.full === true,
			seq: typeof r.seq === 'number' ? r.seq : 0,
			width: typeof r.width === 'number' ? r.width : 0,
			height: typeof r.height === 'number' ? r.height : 0,
		};
	}
	if (r.type === 'terminal.closed') {
		return { type: 'closed', reason: typeof r.reason === 'string' ? r.reason : 'closed' };
	}
	return undefined;
}

export type ControlCommand =
	| { type: 'terminal.input'; text: string }
	| { type: 'terminal.resize'; cols: number; rows: number }
	| { type: 'terminal.scroll'; direction: 'up' | 'down'; lines: number }
	| { type: 'terminal.release' };

export function encodeCommand(command: ControlCommand): string {
	return JSON.stringify(command) + '\n';
}
