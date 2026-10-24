// Applies one named variant from BENCH_SPEC ({ spec, variants }) and prints the spec.
const { spec, variants } = JSON.parse(process.env.BENCH_SPEC);
const v = variants[process.env.VARIANT] || {};
if (v.prepend) spec.init = v.prepend + spec.init;
if (v.append) for (const p of spec.patches || []) p.append += v.append;
for (const s of spec.segments) Object.assign(s.args, v.args || {});
process.stdout.write(JSON.stringify(spec));
