// node experiments/shapes.mjs : monomorphic objects vs mixed shapes vs Float32Array (sum of .x over 1e6 points)
const N = 1e6;
const mono = Array.from({ length: N }, (_, i) => ({ x: i, y: i }));
const mixed = Array.from({ length: N }, (_, i) => (i % 10 === 0 ? { x: i, y: i, z: i } : { x: i, y: i }));
const xs = new Float32Array(N).map((_, i) => i);
function sumObj(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i].x;
  return s;
}
function sumObj2(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i].x;
  return s;
}
function sumTyped(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}
function bench(name, fn, arg) {
  for (let i = 0; i < 20; i++) fn(arg); // warm up: let the JIT optimize
  const t = [];
  for (let i = 0; i < 30; i++) {
    const s = performance.now();
    fn(arg);
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(28)} median ${t[15].toFixed(2)} ms  p95 ${t[28].toFixed(2)} ms`);
}
bench("objects, one shape", sumObj, mono);
bench("objects, every 10th has .z", sumObj2, mixed);
bench("Float32Array", sumTyped, xs);
