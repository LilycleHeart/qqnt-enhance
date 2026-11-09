// 一条命令跑完插件的全部离线测试：node test/run-all.cjs
// 每个测试文件独立进程运行（它们会 monkey-patch require、写临时目录），互不干扰。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".test.cjs"))
    .sort();

let failed = 0;
for (const file of files) {
    process.stdout.write("\n=== " + file + " ===\n");
    const res = spawnSync(process.execPath, [path.join(dir, file)], { stdio: "inherit", timeout: 120000 });
    if (res.status !== 0) {
        failed++;
        process.stdout.write("!! " + file + " 失败（exit " + res.status + (res.signal ? " / " + res.signal : "") + "）\n");
    }
}
process.stdout.write("\n" + (failed ? "FAILED: " + failed + " 个测试文件" : "全部测试通过（" + files.length + " 个文件）") + "\n");
process.exit(failed ? 1 : 0);
