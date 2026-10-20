/**
 * 前端资源回归：零构建的前端没有模块系统，最容易出的两类事故是
 * 1) app.js 语法坏了 / 被写空（整个页面白屏）；
 * 2) 新加的交互元素没有对应 CSS（元素在 DOM 里但用户看不见、以为按钮坏了）。
 *
 * 这里用最便宜的方式兜住这两类：语法检查 + 关键组件类名必须有样式 + 标签配平。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const PUBLIC = resolve(import.meta.dirname, "../public");

function read(name: string): string {
  return readFileSync(resolve(PUBLIC, name), "utf8");
}

describe("前端资源完整性", () => {
  test("app.js 语法可解析（node --check）", () => {
    // 用与运行环境一致的解析器；语法坏了浏览器会整页白屏。
    execFileSync(process.execPath, ["--check", resolve(PUBLIC, "app.js")], {
      stdio: "pipe",
    });
  });

  test("app.js 不是空文件 / 没有被截断", () => {
    const source = read("app.js");
    assert.ok(source.length > 100_000, `app.js 只有 ${source.length} 字节，疑似被截断`);
    assert.match(source, /function renderTimeline\(/, "应包含核心渲染函数");
    assert.match(source, /function sendMessage\(/, "应包含发送消息函数");
  });

  test("关键交互组件的类名必须有样式", () => {
    const css = read("styles.css");
    const critical = [
      // 聊天框提需求的确认框：曾经只加 DOM 没加 CSS，用户点发送后看不到任何反应
      "confirm-dialog",
      "confirm-card",
      // 顶部模型连接状态
      "pill--model",
      // 设置里的 provider 预设
      "provider-chip",
      // 任务卡上的异常徽标
      "task-health-badge",
      // 已移除成员的历史标识
      "msg-retired-badge",
      // 成员管理
      "cat-manage-row",
    ];
    for (const name of critical) {
      assert.ok(
        new RegExp(`\\.${name.replace(/-/g, "\\-")}\\b`).test(css),
        `样式表里缺少 .${name} —— 这个组件会没有样式（用户看不到或以为坏了）`,
      );
    }
  });

  test("index.html 的 dialog / fieldset 标签配平", () => {
    const html = read("index.html");
    const count = (pattern: RegExp): number => (html.match(pattern) ?? []).length;
    assert.equal(count(/<dialog\b/g), count(/<\/dialog>/g), "dialog 标签不配平");
    assert.equal(count(/<fieldset\b/g), count(/<\/fieldset>/g), "fieldset 标签不配平");
    assert.match(html, /src="\/app\.js"/, "应引入 app.js");
  });

  test("index.html 引用的关键元素 id 在 app.js 里被绑定", () => {
    const html = read("index.html");
    const js = read("app.js");
    // 确认框浮层、模型状态、provider 预设是这次改动的核心入口，漏绑定就会「点了没反应」。
    for (const id of ["composer-input", "send-btn", "model-status-pill", "settings-provider-presets"]) {
      assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
      assert.ok(js.includes(`#${id}"`), `app.js 没有绑定 #${id}`);
    }
  });
});
