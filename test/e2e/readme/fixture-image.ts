/**
 * The picture the features image attaches to its draft: a small, neutral mock of an error dialog (a dark window, a title bar,
 * three text lines and a red bar), drawn pixel by pixel and encoded as a PNG, so no screenshot of anything real is involved.
 */
import { crc32, deflateSync } from "node:zlib";

const WIDTH = 240;
const HEIGHT = 150;

type Color = readonly [number, number, number];

function paint(): Buffer {
	const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
	const fill = (x: number, y: number, width: number, height: number, [r, g, b]: Color): void => {
		for (let row = y; row < y + height; row++) {
			for (let column = x; column < x + width; column++) pixels.set([r, g, b], (row * WIDTH + column) * 3);
		}
	};
	fill(0, 0, WIDTH, HEIGHT, [32, 38, 52]);
	fill(14, 14, WIDTH - 28, HEIGHT - 28, [52, 60, 80]);
	fill(14, 14, WIDTH - 28, 20, [74, 98, 150]);
	fill(26, 44, 150, 8, [190, 198, 214]);
	fill(26, 62, 190, 8, [150, 160, 182]);
	fill(26, 80, 120, 8, [150, 160, 182]);
	fill(26, 104, 188, 18, [196, 70, 70]);
	return pixels;
}

export function fixtureImagePng(): Buffer {
	const pixels = paint();
	const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
	for (let y = 0; y < HEIGHT; y++) pixels.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
	const chunk = (type: string, data: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const check = Buffer.alloc(4);
		check.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, check]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(WIDTH, 0);
	header.writeUInt32BE(HEIGHT, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
