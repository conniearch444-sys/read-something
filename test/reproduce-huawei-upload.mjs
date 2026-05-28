// 复现脚本：用 Chrome 114 UA 测试大 IndexedDB 序列化
// 用法: node test/reproduce-huawei-upload.mjs

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Chrome 114 华为浏览器 UA (移动端)
const HUAWEI_CHROME114_UA =
  'Mozilla/5.0 (Linux; Android 12; ALN-AL80) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/15.0.0.300 Mobile Safari/537.36';

// Chrome 114 桌面端 UA (用于对比)
const CHROME114_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

const APP_URL = 'http://localhost:3000/read-something/';
const SEED_SCRIPT_PATH = resolve(__dirname, 'seed-15-books.js');

async function main() {
  console.log('=== 华为浏览器大 IndexedDB 序列化复现测试 ===\n');

  // 读取种子脚本
  const seedScript = readFileSync(SEED_SCRIPT_PATH, 'utf-8');
  console.log(`种子脚本已加载 (${seedScript.length} 字符)\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // 模拟移动端视口
      '--window-size=412,915',
    ],
  });

  const context = await browser.newContext({
    userAgent: HUAWEI_CHROME114_UA,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();

  // 监听 console 消息
  const consoleLogs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[种子脚本]') || text.includes('[测试]') || text.includes('[云同步]') || text.includes('[导出]')) {
      console.log(`  [browser] ${text}`);
    }
    consoleLogs.push({ type: msg.type(), text });
  });

  // 监听页面错误
  page.on('pageerror', (err) => {
    console.error(`  [PAGE ERROR] ${err.message}`);
  });

  try {
    // Step 1: 打开应用
    console.log('Step 1: 打开应用...');
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`  页面标题: ${await page.title()}`);
    console.log(`  当前 URL: ${page.url()}\n`);

    // Step 2: 注入种子脚本
    console.log('Step 2: 注入种子脚本...');
    await page.evaluate(seedScript);
    // 等待种子脚本完成 (seed 是异步的)
    await page.waitForTimeout(5000);

    // 检查种子是否成功
    const seedCheck = await page.evaluate(() => {
      const booksRaw = localStorage.getItem('app_books');
      if (!booksRaw) return { ok: false, error: 'localStorage app_books 为空' };
      const books = JSON.parse(booksRaw);
      return { ok: true, bookCount: books.length, titles: books.map(b => b.title) };
    });
    console.log(`  种子检查: ${JSON.stringify(seedCheck)}\n`);

    // Step 3: 测试导出序列化
    console.log('Step 3: 测试 createAppArchivePayload + JSON.stringify...');
    const exportResult = await page.evaluate(() => {
      if (typeof window.testExportArchive !== 'function') {
        return { error: 'testExportArchive 函数不可用，种子脚本可能未成功注入' };
      }
      return window.testExportArchive();
    });
    console.log(`  导出结果: ${JSON.stringify(exportResult, null, 2)}\n`);

    // Step 4: 测试模拟上传
    console.log('Step 4: 测试模拟上传流程...');
    const uploadResult = await page.evaluate(() => {
      if (typeof window.testUploadSimulation !== 'function') {
        return { error: 'testUploadSimulation 不可用' };
      }
      return window.testUploadSimulation();
    });
    console.log(`  上传模拟结果: ${JSON.stringify(uploadResult, null, 2)}\n`);

    // Step 5: 直接测试 JSON.stringify 大对象（绕过 IndexedDB）
    console.log('Step 5: 纯 JSON.stringify 压力测试（绕过 IndexedDB）...');
    const pureJsonResult = await page.evaluate(() => {
      const encoder = new TextEncoder();
      const results = [];

      // 测试不同大小的 JSON 序列化
      const sizes = [
        { label: '1 MB', bytes: 1 * 1024 * 1024 },
        { label: '5 MB', bytes: 5 * 1024 * 1024 },
        { label: '10 MB', bytes: 10 * 1024 * 1024 },
        { label: '15 MB', bytes: 15 * 1024 * 1024 },
        { label: '20 MB', bytes: 20 * 1024 * 1024 },
        { label: '25 MB', bytes: 25 * 1024 * 1024 },
        { label: '30 MB', bytes: 30 * 1024 * 1024 },
      ];

      for (const size of sizes) {
        try {
          // 生成接近目标大小的字符串
          const para = '这是一段测试文本用于模拟书籍内容。' +
            '夜色渐深窗外的梧桐树叶在微风中沙沙作响他坐在书桌前手指轻轻敲击着桌面。' +
            '本章讲述了主人公在一个寒冷的冬夜回忆起过往的种种经历那些被时光掩埋的秘密。';
          let text = '';
          while (encoder.encode(text).length < size.bytes) {
            text += para;
          }
          // 裁剪到目标大小
          while (encoder.encode(text).length > size.bytes) {
            text = text.slice(0, -50);
          }

          const obj = {
            meta: { schema: 'test', version: 1 },
            data: { text },
          };

          const start = performance.now();
          const json = JSON.stringify(obj);
          const elapsed = performance.now() - start;
          const actualBytes = encoder.encode(json).length;

          results.push({
            label: size.label,
            targetBytes: size.bytes,
            actualBytes,
            actualMB: (actualBytes / 1024 / 1024).toFixed(2),
            elapsedMs: Math.round(elapsed),
            success: true,
          });
        } catch (err) {
          results.push({
            label: size.label,
            targetBytes: size.bytes,
            success: false,
            error: err.message || String(err),
          });
        }
      }

      return results;
    });
    console.log('  纯 JSON 压力测试结果:');
    for (const r of pureJsonResult) {
      if (r.success) {
        console.log(`    ${r.label}: OK, 实际 ${r.actualMB} MB, 耗时 ${r.elapsedMs}ms`);
      } else {
        console.log(`    ${r.label}: FAILED - ${r.error}`);
      }
    }

    // Step 6: 使用桌面版 Chrome 114 UA 的浏览器做对比
    console.log('\nStep 6: 使用桌面版 Chrome114 UA 对比测试...');
    const desktopContext = await browser.newContext({
      userAgent: CHROME114_DESKTOP_UA,
      viewport: { width: 1920, height: 1080 },
    });
    const desktopPage = await desktopContext.newPage();

    desktopPage.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[种子脚本]') || text.includes('[测试]') || text.includes('[导出]')) {
        console.log(`  [desktop] ${text}`);
      }
    });

    await desktopPage.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await desktopPage.evaluate(seedScript);
    await desktopPage.waitForTimeout(5000);

    const desktopExportResult = await desktopPage.evaluate(() => {
      if (typeof window.testExportArchive !== 'function') {
        return { error: 'testExportArchive 不可用' };
      }
      return window.testExportArchive();
    });
    console.log(`  桌面版导出结果: ${JSON.stringify(desktopExportResult, null, 2)}`);

    await desktopContext.close();

    // 总结
    console.log('\n=== 测试总结 ===');
    if (exportResult.success !== undefined && !exportResult.success) {
      console.log('结果: 在 Chrome 114 UA 下导出/序列化失败！');
      console.log(`错误: ${exportResult.error}`);
    } else if (exportResult.success) {
      console.log(`结果: 序列化成功，JSON 大小 ${exportResult.jsonSizeMB} MB`);
      console.log('如果在真实华为浏览器上失败，可能是以下原因之一：');
      console.log('  1. IndexedDB 游标读取大文本时内存不足');
      console.log('  2. JSON.stringify 对超长字符串有限制');
      console.log('  3. fetch body 大小超出浏览器限制');
      console.log('  4. 移动端内存限制更严格');
    }

  } catch (err) {
    console.error('测试执行失败:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
  }

  // 输出所有相关的浏览器日志
  console.log('\n--- 完整浏览器日志 ---');
  for (const log of consoleLogs) {
    if (log.text.includes('[种子脚本]') || log.text.includes('[测试]') || log.text.includes('[导出]') || log.text.includes('[云同步]')) {
      console.log(`  [${log.type}] ${log.text}`);
    }
  }
}

main().catch((err) => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
