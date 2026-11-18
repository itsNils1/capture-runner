import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const SPEC_URL = process.env.JOB_SPEC_URL || "";
const SPEC_JSON = process.env.SPEC_JSON || "";
const TOKEN = process.env.JOB_TOKEN || "";
const JOB = process.env.JOB_ID || "";
const PART = process.env.JOB_PART || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_FRAMES = Number(process.env.MAX_FRAMES) || Number.POSITIVE_INFINITY;
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const HEADFUL = process.env.HEADFUL === "1";
const DEFAULT_ARGS = [
	"--use-angle=swiftshader",
	"--enable-unsafe-swiftshader",
];
const CHROME_ARGS = process.env.CHROME_ARGS
	? process.env.CHROME_ARGS.split(/\s+/).filter(Boolean)
	: DEFAULT_ARGS;
const STALE_MS = 15_000;

if (!TOKEN || (!SPEC_JSON && (!SPEC_URL || !/^[0-9a-f]{16,64}$/.test(JOB)))) {
	console.error("missing JOB_TOKEN and a spec source");
	process.exit(2);
}
if (PART && !/^\d{1,3}$/.test(PART)) {
	console.error("invalid JOB_PART");
	process.exit(2);
}
const work = resolve("work", PART ? `part-${PART}` : "single");
mkdirSync(work, { recursive: true });
let progressUrl = null;

async function call(url, options = {}) {
	const res = await fetch(url, {
		...options,
		headers: { ...(options.headers || {}), "x-job-token": TOKEN },
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok) throw new Error(`server answered HTTP ${res.status}`);
	return res;
}

async function progress(stage, done, error) {
	if (!progressUrl || DRY_RUN) return;
	try {
		await call(progressUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ stage, done, error }),
		});
	} catch {}
}

function ffmpeg(args, piped) {
	const proc = spawn(FFMPEG, ["-y", "-loglevel", "error", ...args], {
		stdio: [piped ? "pipe" : "ignore", "ignore", "inherit"],
	});
	const finished = new Promise((ok, fail) =>
		proc.on("close", (code) =>
			code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)),
		),
	);
	return { proc, finished };
}

async function settle(page, inflight, minMs, quietMs, maxMs) {
	const start = Date.now();
	let quietSince = Date.now();
	while (Date.now() - start < maxMs) {
		await page.evaluate(() => window.__job.step(0));
		await new Promise((r) => setTimeout(r, 50));
		const now = Date.now();
		for (const [req, at] of inflight)
			if (now - at > STALE_MS) inflight.delete(req);
		if (inflight.size) quietSince = now;
		if (now - start >= minMs && now - quietSince >= quietMs) return;
	}
}

async function openPage(browser, spec) {
	const page = await browser.newPage();
	await page.setUserAgent(
		(await browser.userAgent()).replace("HeadlessChrome", "Chrome"),
	);
	const renderer = await page.evaluate(() => {
		const gl = document.createElement("canvas").getContext("webgl2");
		const info = gl?.getExtension("WEBGL_debug_renderer_info");
		return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "none";
	});
	console.log(`webgl: ${renderer}`);
	const inflight = new Map();
	page.on("console", (m) => pageLogs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
	page.on("pageerror", (e) => pageLogs.push(`error: ${e.message}`.slice(0, 300)));
	page.on("request", (r) => inflight.set(r, Date.now()));
	page.on("requestfinished", (r) => inflight.delete(r));
	page.on("requestfailed", (r) => inflight.delete(r));
	await page.evaluateOnNewDocument(spec.init);
	await page.setRequestInterception(true);
	page.on("request", async (r) => {
		if (r.isInterceptResolutionHandled()) return;
		const url = new URL(r.url());
		if (url.origin !== spec.origin) return r.continue();
		const headers = { ...r.headers(), "x-job-token": TOKEN };
		const patch = (spec.patches || []).find((p) =>
			url.pathname.endsWith(p.pathSuffix),
		);
		try {
			if (!patch && r.method() !== "GET") return r.continue({ headers });
			const res = await fetchRetry(r.url(), headers);
			const out = {};
			for (const [k, v] of res.headers)
				if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k))
					out[k] = v;
			r.respond({
				status: res.status,
				headers: out,
				contentType: res.headers.get("content-type") || "text/javascript",
				body: patch
					? `${await res.text()}${patch.append}`
					: Buffer.from(await res.arrayBuffer()),
			});
		} catch {
			r.abort();
		}
	});
	return { page, inflight };
}

// Private notes for a stuck page; only written when DIAG_DIR is set.
async function saveDiag(page, inflight) {
	if (!process.env.DIAG_DIR) return;
	const now = Date.now();
	const text = await page.evaluate(() => document.body.innerText.slice(0, 2000));
	const open = [...inflight].map(([r, at]) => [r.url(), now - at]);
	mkdirSync(process.env.DIAG_DIR, { recursive: true });
	writeFileSync(
		join(process.env.DIAG_DIR, "diag.json"),
		JSON.stringify({ text, open, logs: pageLogs.slice(-80) }, null, 1),
	);
}

const pageLogs = [];

// The site sometimes answers 502/503 under load; a retry usually works.
async function fetchRetry(url, headers) {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(30_000),
			});
			if (![502, 503, 504].includes(res.status) || attempt >= 4) return res;
			await res.arrayBuffer().catch(() => {});
		} catch (err) {
			if (attempt >= 4) throw err;
		}
		retries++;
		await new Promise((ok) => setTimeout(ok, 250 * 2 ** attempt));
	}
}

let retries = 0;

async function fetchBase64(url) {
	return Buffer.from(await (await call(url)).arrayBuffer()).toString("base64");
}

async function recordSegment(page, inflight, spec, segment, index) {
	if (segment.load) {
		const t0 = Date.now();
		await page.goto(segment.load, {
			waitUntil: "domcontentloaded",
			timeout: 120_000,
		});
		try {
			await page.waitForSelector(spec.readySelector, {
				timeout: Number(process.env.READY_TIMEOUT_MS) || 180_000,
			});
		} catch (err) {
			await saveDiag(page, inflight).catch(() => {});
			throw err;
		}
		if (spec.css) await page.addStyleTag({ content: spec.css });
		await page.evaluate(() => window.__job.ready());
		if (retries) console.log(`${retries} request(s) retried`);
	console.log(`page ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	}
	if (segment.realistic) return recordRealistic(page, inflight, spec, segment, index);
	const t1 = Date.now();
	await page.evaluate((args) => window.__job.prepare(args), segment.args);
	await settle(page, inflight, 700, 450, 25_000);
	await page.evaluate(() => window.__job.settled());
	await settle(page, inflight, 0, 200, 4000);
	for (const [key, url] of Object.entries(segment.overlays || {})) {
		const data = await fetchBase64(url);
		await page.evaluate((k, d) => window.__job.setOverlay(k, d), key, data);
	}
	console.log(`segment prepared in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
	const { fps, preset, crf } = spec.encode;
	const out = join(work, `part-${index}.mp4`);
	const { proc, finished } = ffmpeg(
		[
			"-f",
			"image2pipe",
			"-framerate",
			String(fps),
			"-c:v",
			"mjpeg",
			"-i",
			"-",
			"-pix_fmt",
			"yuv420p",
			"-r",
			String(fps),
			"-c:v",
			"libx264",
			"-preset",
			preset,
			"-crf",
			String(crf),
			"-g",
			String(fps * 2),
			out,
		],
		true,
	);
	const write = async (b64) => {
		if (!b64) return;
		if (!proc.stdin.write(Buffer.from(b64, "base64")))
			await new Promise((r) => proc.stdin.once("drain", r));
	};
	const frames = Math.min(segment.frames, MAX_FRAMES);
	const t2 = Date.now();
	let waitMs = 0;
	let writeMs = 0;
	for (let f = 0; f < frames; f++) {
		const a = Date.now();
		const data = await page.evaluate((i) => window.__job.frame(i), f);
		const b = Date.now();
		await write(data);
		waitMs += b - a;
		writeMs += Date.now() - b;
	}
	await write(await page.evaluate(() => window.__job.flush()));
	const captureMs = Date.now() - t2;
	proc.stdin.end();
	await finished;
	const st = await page.evaluate(() => window.__job.stats?.() ?? null);
	const ms = (v) => `${Math.round(v)}ms`;
	if (st)
		console.log(
			`per frame: draw ${ms(st.draw)}, compose ${ms(st.compose)}, jpeg ${ms(st.encode)}, page call ${ms(waitMs / frames)}, pipe ${ms(writeMs / frames)}`,
		);
	console.log(
		`captured ${frames} frames in ${(captureMs / 1000).toFixed(1)}s (${Math.round(captureMs / frames)} ms/frame), encode tail ${((Date.now() - t2 - captureMs) / 1000).toFixed(1)}s`,
	);
	return out;
}

function encoder(spec, out) {
	const { fps, preset, crf } = spec.encode;
	return ffmpeg(
		[
			"-f",
			"image2pipe",
			"-framerate",
			String(fps),
			"-c:v",
			"mjpeg",
			"-i",
			"-",
			"-pix_fmt",
			"yuv420p",
			"-r",
			String(fps),
			"-c:v",
			"libx264",
			"-preset",
			preset,
			"-crf",
			String(crf),
			"-g",
			String(fps * 2),
			out,
		],
		true,
	);
}

// A long realistic clip is rendered by several runners at once. Every one of
// them plans the whole clip (the plan is seeded, so all of them get the same
// one) and renders only its share: part k of n. The cuts go where the
// director already cuts away, behind the /goto loading screen, when one is
// near an even split, and on the even split otherwise.
function partRange(info, range) {
	const total = info.frames;
	const n = Number(range?.of);
	const k = Number(range?.part);
	if (!(n > 1) || !(k >= 0 && k < n)) return { from: 0, to: total };
	const shots = info.shots || [];
	const seams = shots
		.filter((s, i) => i > 0 && s.kind === "arrive" && shots[i - 1].kind === "goto")
		.map((s) => s.outFrom);
	const reach = Math.floor(total / n / 3);
	const cuts = [0];
	for (let i = 1; i < n; i++) {
		const ideal = Math.round((i * total) / n);
		const seam = seams
			.filter((s) => Math.abs(s - ideal) <= reach && s > cuts.at(-1))
			.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
		cuts.push(seam ?? Math.max(cuts.at(-1) + 1, ideal));
	}
	cuts.push(total);
	return { from: Math.min(cuts[k], total), to: Math.min(cuts[k + 1], total) };
}

// Plays the director up to the first frame of this part without drawing
// anything, so the camera, chat and HUD arrive there exactly as they would
// had every earlier frame been rendered.
async function catchUp(page, from, fps) {
	const batch = 30;
	for (let f = 0; f < from; f += batch) {
		await page.evaluate(
			async (a, b, rate) => {
				for (let i = a; i < b; i++) {
					await window.__realistic.prepareFrame(i);
					if (window.__job.realisticSkip) window.__job.realisticSkip(rate);
					else window.__job.realisticFrame(rate, 0.1);
				}
			},
			f,
			Math.min(from, f + batch),
			fps,
		);
	}
	await page.evaluate(() => window.__job.flush());
}

// A realistic clip is planned by the viewer's director, which decides the
// length (rewinds, pauses, transitions) and drives the camera frame by frame.
// Its game sound is rendered in the page afterwards and muxed in here; a
// silent track stands in when that fails so every part has audio.
async function recordRealistic(page, inflight, spec, segment, index) {
	const t1 = Date.now();
	await page.waitForFunction(() => window.__realistic?.ready?.(), {
		timeout: 60_000,
		polling: 250,
	});
	await settle(page, inflight, 700, 450, 25_000);
	const info = await page.evaluate(
		(args) => window.__realistic.plan(args),
		segment.args,
	);
	console.log(
		`realistic plan: ${info.frames} frames, ${info.shots?.length ?? 0} shot(s), prepared in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
	);
	const fps = spec.encode.fps;
	const quality = segment.args?.quality ?? 0.95;
	const { from, to } = partRange(info, segment.range);
	if (from > 0) {
		const t0 = Date.now();
		await progress(`Catching up to clip ${index + 1}`, index);
		await catchUp(page, from, fps);
		// Nothing was drawn on the way here, so the world around this frame is
		// finished loading now. Not with settle(): its idle steps move the
		// camera, and this part would no longer match the frames before it.
		await page.evaluate(() => window.__job.realisticSettle?.());
		console.log(
			`part ${segment.range.part + 1} of ${segment.range.of}: caught up ${from} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
		);
	}
	const video = join(work, `part-${index}-video.mp4`);
	const { proc, finished } = encoder(spec, video);
	const write = async (b64) => {
		if (!b64) return;
		if (!proc.stdin.write(Buffer.from(b64, "base64")))
			await new Promise((r) => proc.stdin.once("drain", r));
	};
	const frames = Math.min(to - from, MAX_FRAMES);
	const t2 = Date.now();
	for (let f = 0; f < frames; f++) {
		const data = await page.evaluate(
			async (i, rate, q) => {
				await window.__realistic.prepareFrame(i);
				return window.__job.realisticFrame(rate, q);
			},
			from + f,
			fps,
			quality,
		);
		await write(data);
		if (f % (fps * 5) === 0)
			await progress(`Rendering clip ${index + 1} (${Math.round((f / frames) * 100)}%)`, index);
	}
	await write(await page.evaluate(() => window.__job.flush()));
	proc.stdin.end();
	await finished;
	const captureMs = Date.now() - t2;
	console.log(
		`captured ${frames} frames in ${(captureMs / 1000).toFixed(1)}s (${Math.round(captureMs / frames)} ms/frame)`,
	);
	const seconds = frames / fps;
	const wav = join(work, `part-${index}.wav`);
	const sound = await page
		.evaluate(async (volume) => {
			const sound = await window.__realistic.renderAudio({ volume });
			if (!sound?.channels?.length) return null;
			const buffer = { sampleRate: sound.sampleRate };
			const left = sound.channels[0];
			const right = sound.channels[1] ?? left;
			const length = left.length;
			const bytes = new Uint8Array(44 + length * 4);
			const view = new DataView(bytes.buffer);
			const tag = (at, text) => {
				for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
			};
			tag(0, "RIFF");
			view.setUint32(4, 36 + length * 4, true);
			tag(8, "WAVE");
			tag(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 2, true);
			view.setUint32(24, buffer.sampleRate, true);
			view.setUint32(28, buffer.sampleRate * 4, true);
			view.setUint16(32, 4, true);
			view.setUint16(34, 16, true);
			tag(36, "data");
			view.setUint32(40, length * 4, true);
			for (let i = 0; i < length; i++) {
				const l = Math.max(-1, Math.min(1, left[i]));
				const r = Math.max(-1, Math.min(1, right[i]));
				view.setInt16(44 + i * 4, l * 32767, true);
				view.setInt16(46 + i * 4, r * 32767, true);
			}
			let text = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return btoa(text);
		}, segment.gameVolume ?? 0.8)
		.catch((err) => {
			console.log(`game sound failed: ${err.message}`);
			return null;
		});
	if (sound) writeFileSync(wav, Buffer.from(sound, "base64"));
	const out = join(work, `part-${index}.mp4`);
	await ffmpeg([
		"-i",
		video,
		...(sound
			? ["-ss", (from / fps).toFixed(4), "-i", wav]
			: ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
		"-map",
		"0:v",
		"-map",
		"1:a",
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-t",
		seconds.toFixed(3),
		out,
	]).finished;
	console.log(`game sound ${sound ? "added" : "missing, silent track used"}`);
	return out;
}

async function loadSpec() {
	if (SPEC_JSON) return JSON.parse(SPEC_JSON);
	const part = PART ? `&part=${PART}` : "";
	return (
		await call(`${SPEC_URL}?id=${encodeURIComponent(JOB)}${part}`)
	).json();
}

async function main() {
	const started = Date.now();
	const spec = await loadSpec();
	progressUrl = spec.progressUrl;
	const total = spec.segments.length;
	console.log(`${total} segment(s)`);
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: !HEADFUL,
		args: [
			...CHROME_ARGS,
			"--hide-scrollbars",
			"--mute-audio",
			"--no-sandbox",
			`--window-size=${spec.viewport.width},${spec.viewport.height}`,
		],
		defaultViewport: spec.viewport,
	});
	const parts = [];
	try {
		const { page, inflight } = await openPage(browser, spec);
		for (const [i, segment] of spec.segments.entries()) {
			await progress(`Rendering clip ${i + 1} of ${total}`, i);
			parts.push(await recordSegment(page, inflight, spec, segment, i));
		}
	} finally {
		await browser.close();
	}
	const output = join(work, "output.mp4");
	if (parts.length === 1) {
		writeFileSync(output, readFileSync(parts[0]));
	} else {
		const list = join(work, "list.txt");
		writeFileSync(
			list,
			parts.map((p) => `file '${p.replaceAll("\\", "/")}'`).join("\n"),
		);
		await ffmpeg([
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			list,
			"-c",
			"copy",
			"-movflags",
			"+faststart",
			output,
		]).finished;
	}
	console.log(
		`output ${(statSync(output).size / 1048576).toFixed(1)} MB after ${((Date.now() - started) / 1000).toFixed(1)}s`,
	);
	if (DRY_RUN) return;
	await call(spec.uploadUrl, {
		method: "PUT",
		headers: { "Content-Type": "video/mp4" },
		body: readFileSync(output),
	});
	console.log("uploaded");
}

main().catch(async (err) => {
	console.error(`failed: ${err.message}`);
	await progress("Failed", 0, err.message.slice(0, 180));
	process.exit(1);
});
