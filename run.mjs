import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const SPEC_URL = process.env.JOB_SPEC_URL || "";
const TOKEN = process.env.JOB_TOKEN || "";
const JOB = process.env.JOB_ID || "";
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const GPU = process.env.GPU === "1";
const STALE_MS = 15_000;

if (!SPEC_URL || !TOKEN || !/^[0-9a-f]{16,64}$/.test(JOB)) {
	console.error("missing JOB_SPEC_URL, JOB_TOKEN or a valid JOB_ID");
	process.exit(2);
}
const work = resolve("work");
mkdirSync(work, { recursive: true });
let progressUrl = null;

async function call(url, options = {}) {
	const res = await fetch(url, {
		...options,
		headers: { ...(options.headers || {}), "x-job-token": TOKEN },
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`server answered HTTP ${res.status}`);
	return res;
}

async function progress(stage, done, error) {
	if (!progressUrl) return;
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
	await page.evaluate((args) => window.__job.prepare(args), segment.args);
	await settle(page, inflight, 700, 450, 25_000);
	await page.evaluate(() => window.__job.settled());
	await settle(page, inflight, 0, 200, 4000);
	for (const [key, url] of Object.entries(segment.overlays || {})) {
		const data = await fetchBase64(url);
		await page.evaluate((k, d) => window.__job.setOverlay(k, d), key, data);
	}
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
	for (let f = 0; f < segment.frames; f++)
		await write(await page.evaluate((i) => window.__job.frame(i), f));
	await write(await page.evaluate(() => window.__job.flush()));
	proc.stdin.end();
	await finished;
	return out;
}

async function main() {
	const spec = await (
		await call(`${SPEC_URL}?id=${encodeURIComponent(JOB)}`)
	).json();
	progressUrl = spec.progressUrl;
	const total = spec.segments.length;
	console.log(`${total} segment(s)`);
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: true,
		args: [
			...(GPU
				? ["--enable-gpu", "--ignore-gpu-blocklist"]
				: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
			"--hide-scrollbars",
			"--mute-audio",
			"--no-sandbox",
		],
		defaultViewport: spec.viewport,
	});
	const parts = [];
	try {
		const { page, inflight } = await openPage(browser, spec);
		for (const [i, segment] of spec.segments.entries()) {
			await progress(`Rendering clip ${i + 1} of ${total}`, i);
			const t0 = Date.now();
			parts.push(await recordSegment(page, inflight, spec, segment, i));
			console.log(
				`segment ${i + 1}/${total} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
			);
		}
	} finally {
		await browser.close();
	}
	await progress("Joining the clips", total);
	const list = join(work, "list.txt");
	writeFileSync(
		list,
		parts.map((p) => `file '${p.replaceAll("\\", "/")}'`).join("\n"),
	);
	const output = join(work, "output.mp4");
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
	console.log(`output ${(statSync(output).size / 1048576).toFixed(1)} MB`);
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
