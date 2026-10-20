/**
 * 沙盒初始内容：一个很小的 Node 项目。
 *
 * 成员不是凭空写字——他们在这个目录里真的改文件、真的跑测试。
 * 初始代码是「有坑」的，测试是稳定的裁判。
 */

export const SEED_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "cafe-sandbox",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    },
    null,
    2,
  ),

  "README.md": `# 交付台沙盒项目

这是成员们干活的地方。测试是裁判：

\`\`\`bash
npm test
\`\`\`

- \`src/remember.js\` —— 登录页「记住我」的 7 天 token
- \`src/export.js\` —— 后台导出 CSV
`,

  // ── 记住我：初始版本没有过期字段，测试会失败 ──────────────────
  "src/remember.js": `// 登录页「记住我」：7 天内免登录的 token。
const TOKENS = new Map();

export function signRememberToken(userId, now = Date.now()) {
  const token = \`rm_\${userId}_\${Math.random().toString(36).slice(2)}\`;
  TOKENS.set(token, { userId });
  return token;
}

export function verifyRememberToken(token, _now = Date.now()) {
  return TOKENS.get(token) ?? null;
}
`,

  "test/remember.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { signRememberToken, verifyRememberToken } from "../src/remember.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_760_000_000_000;

test("签发时写入 7 天过期时间", () => {
  const token = signRememberToken("u1", T0);
  const record = verifyRememberToken(token, T0);
  assert.ok(record);
  assert.equal(record.expiresAt, T0 + 7 * DAY);
});

test("过期后校验失败", () => {
  const token = signRememberToken("u1", T0);
  assert.equal(verifyRememberToken(token, T0 + 8 * DAY), null);
});

test("有效期内校验通过", () => {
  const token = signRememberToken("u1", T0);
  assert.equal(verifyRememberToken(token, T0 + 6 * DAY)?.userId, "u1");
});
`,

  // ── 导出 CSV：初始版本是正确的；剧本会先写坏一版再修 ──────────
  "src/export.js": `// 后台导出 CSV。
function escapeCell(value) {
  const text = String(value ?? "");
  return /[",\\n\\r]/.test(text) ? \`"\${text.replace(/"/g, '""')}"\` : text;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(",")).join("\\n");
}
`,

  "test/export.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/export.js";

test("普通字段直接拼接", () => {
  assert.equal(toCsv([["name", "note"], ["a", "b"]]), "name,note\\na,b");
});

test("逗号字段要加引号", () => {
  assert.equal(toCsv([["name", "note"], ["a", "b,c"]]), 'name,note\\na,"b,c"');
});

test("引号要 doubling，换行要加引号", () => {
  assert.equal(
    toCsv([["he said \\"hi\\"", "line1\\nline2"]]),
    '"he said ""hi""","line1\\nline2"',
  );
});
`,
};
