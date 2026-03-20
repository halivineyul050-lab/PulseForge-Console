"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist");
const packageName = "PulseForge-Console-Windows";
const outputDir = path.join(distRoot, packageName);
const zipName = `${packageName}.zip`;
const zipPath = path.join(distRoot, zipName);

const includeFiles = [
  "server.js",
  "app.js",
  "index.html",
  "styles.css",
  "agent.js",
  "sqlite-store.js",
  "notifier.js",
  "ai-analyzer.js",
  "package.json",
  "package-lock.json",
  "README.md"
];

function ensureExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Required path missing: ${targetPath}`);
  }
}

function cleanAndInit() {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, "data"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "logs"), { recursive: true });
}

function copyProjectFiles() {
  for (const relativePath of includeFiles) {
    const sourcePath = path.join(root, relativePath);
    ensureExists(sourcePath);
    const destPath = path.join(outputDir, relativePath);
    fs.cpSync(sourcePath, destPath, { recursive: true });
  }

}

function installProductionDependencies() {
  console.log("[package:win] installing production dependencies...");
  execSync("npm ci --omit=dev --no-audit --no-fund", {
    cwd: outputDir,
    stdio: "inherit"
  });
}

function writeLauncherScripts() {
  const startScript = [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0\"",
    "if not exist logs mkdir logs",
    "if not exist data mkdir data",
    "if \"%PORT%\"==\"\" set PORT=4510",
    "if \"%SQLITE_STRICT_STARTUP%\"==\"\" set SQLITE_STRICT_STARTUP=1",
    "echo [PulseForge] starting at http://127.0.0.1:%PORT%",
    "start \"PulseForge Console\" cmd /c \"node server.js ^> logs\\server.log 2^>^&1\"",
    "timeout /t 3 >nul",
    "start \"\" \"http://127.0.0.1:%PORT%\"",
    "echo [PulseForge] started. log=logs\\server.log",
    "endlocal",
    ""
  ].join("\r\n");

  const stopScript = [
    "@echo off",
    "setlocal",
    "if \"%PORT%\"==\"\" set PORT=4510",
    "for /f %%i in ('powershell -NoProfile -Command \"(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty OwningProcess)\"') do set PID=%%i",
    "if \"%PID%\"==\"\" (",
    "  echo [PulseForge] no listener on port %PORT%",
    "  endlocal",
    "  exit /b 0",
    ")",
    "echo [PulseForge] stopping PID %PID%",
    "taskkill /PID %PID% /F >nul 2>nul",
    "echo [PulseForge] stopped",
    "endlocal",
    ""
  ].join("\r\n");

  const startAgentTemplate = [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0\"",
    "if \"%PF_MASTER_URL%\"==\"\" set PF_MASTER_URL=http://127.0.0.1:4510",
    "if \"%PF_AGENT_HOST_ID%\"==\"\" set PF_AGENT_HOST_ID=agent:%COMPUTERNAME%",
    "echo [PulseForge Agent] master=%PF_MASTER_URL% host=%PF_AGENT_HOST_ID%",
    "node agent.js",
    "endlocal",
    ""
  ].join("\r\n");

  fs.writeFileSync(path.join(outputDir, "启动监控.bat"), startScript, "utf8");
  fs.writeFileSync(path.join(outputDir, "停止监控.bat"), stopScript, "utf8");
  fs.writeFileSync(path.join(outputDir, "启动Agent示例.bat"), startAgentTemplate, "utf8");
}

function writePackageReadme() {
  const readme = `# PulseForge Console（Windows 分发包）

## 使用方式

1. 双击 "启动监控.bat" 启动服务并自动打开浏览器。
2. 默认地址：http://127.0.0.1:4510
3. 停止服务：双击 "停止监控.bat"

## 目录说明

- logs/server.log：服务日志
- data/：SQLite 持久化数据

## 可选环境变量（高级）

- PORT：端口（默认 4510）
- AI_ANALYZER_API_KEY：开启云端 AI 分析
- ALERT_WEBHOOK_URL / WECHAT_WEBHOOK_URL / DINGTALK_WEBHOOK_URL：告警通知

## 远端 Agent 示例

可参考 "启动Agent示例.bat"，或在命令行执行：

set PF_MASTER_URL=http://<主控机IP>:4510 && set PF_AGENT_HOST_ID=agent:host-a && node agent.js
`;

  fs.writeFileSync(path.join(outputDir, "使用说明-分发版.md"), readme, "utf8");
}

function createZip() {
  fs.mkdirSync(distRoot, { recursive: true });
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }

  const psCommand = `Compress-Archive -Path "${outputDir}\\*" -DestinationPath "${zipPath}" -Force`;
  execSync(`powershell -NoProfile -Command "${psCommand}"`, {
    cwd: root,
    stdio: "inherit"
  });
}

function main() {
  console.log("[package:win] building distributable...");
  cleanAndInit();
  copyProjectFiles();
  installProductionDependencies();
  writeLauncherScripts();
  writePackageReadme();
  createZip();
  console.log(`[package:win] done: ${outputDir}`);
  console.log(`[package:win] zip: ${zipPath}`);
}

main();
