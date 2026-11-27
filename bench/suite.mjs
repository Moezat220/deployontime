// A stand-in test suite for the benchmark.
// It starts THREADS worker threads. Each one holds MEM_MB of memory and runs TESTS timed tests. A test is a fixed
// amount of CPU work, and it fails when it takes longer than DEADLINE_MS, like a real test with a timeout.
// It prints one JSON line and exits 1 when any test failed.
//
// usage: node suite.mjs <threads> <tests> <work> <deadlineMs> <memMB>
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function cpuWork(units) {
    let x = 0;
    for (let i = 0; i < units * 1e6; i++) x = (x * 31 + i) % 1000003;
    return x;
}

function runTests({ tests, work, deadline, memMB }) {
    const hold = Buffer.alloc(memMB * 1024 * 1024);
    for (let i = 0; i < hold.length; i += 4096) hold[i] = 1;
    const times = [];
    for (let t = 0; t < tests; t++) {
        const start = performance.now();
        cpuWork(work);
        for (let i = 0; i < hold.length; i += 65536) hold[i]++;
        times.push(performance.now() - start);
    }
    return { times, failed: times.filter((ms) => ms > deadline).length };
}

if (!isMainThread) {
    parentPort.postMessage(runTests(workerData));
} else {
    const [threads, tests, work, deadline, memMB] = process.argv.slice(2).map(Number);
    const data = { tests, work, deadline, memMB };
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: data });
        worker.on("message", resolve);
        worker.on("error", reject);
    })));
    const all = results.flatMap((r) => r.times).sort((a, b) => a - b);
    const failed = results.reduce((sum, r) => sum + r.failed, 0);
    console.log(JSON.stringify({
        tests: all.length,
        failed,
        medianMs: Math.round(all[Math.floor(all.length / 2)]),
        seconds: Math.round((performance.now() - start) / 100) / 10,
    }));
    process.exit(failed ? 1 : 0);
}
