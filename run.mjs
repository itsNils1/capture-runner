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
const work = resolve("work");
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
		if (!patch) return r.continue({ headers });
		try {
			const res = await fetch(r.url(), { headers });
			r.respond({
				status: res.status,
				contentType: res.headers.get("content-type") || "text/javascript",
				body: `${await res.text()}${patch.append}`,
			});
		} catch {
			r.abort();
		}
	});
	return { page, inflight };
}

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
		await page.waitForSelector(spec.readySelector, { timeout: 180_000 });
		if (spec.css) await page.addStyleTag({ content: spec.css });
		await page.evaluate(() => window.__job.ready());
		console.log(`page ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	}
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
	for (let f = 0; f < frames; f++)
		await write(await page.evaluate((i) => window.__job.frame(i), f));
	await write(await page.evaluate(() => window.__job.flush()));
	const captureMs = Date.now() - t2;
	proc.stdin.end();
	await finished;
	console.log(
		`captured ${frames} frames in ${(captureMs / 1000).toFixed(1)}s (${Math.round(captureMs / frames)} ms/frame), encode tail ${((Date.now() - t2 - captureMs) / 1000).toFixed(1)}s`,
	);
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
