const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://carlosduenas101.github.io/Trade-Tracker/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    document.getElementById('loginScreen').hidden = true;
    document.querySelector('.main-content').style.display = 'flex';
    document.getElementById('userInfo').hidden = false;
    document.getElementById('userNameDisplay').textContent = 'carlos';
    ['metricWinRate','metricPnl','metricTotalLosses','metricDrawdown',
     'metricMaxProfit','metricRR','metricStreak','metricTotal',
     'metricAvgRoe','metricAvgEntries','metricAvgDuration','metricAvgPnl'].forEach((id,i) => {
      var el = document.getElementById(id);
      if (el) { el.textContent = i % 2 === 0 ? '+$420' : '68%'; el.classList.remove('skeleton'); }
    });
  });
  await page.waitForTimeout(500);

  await page.screenshot({ path: 'pw_header.png',  clip: { x:0, y:0,   width:390, height:60  } });
  await page.screenshot({ path: 'pw_toolbar.png', clip: { x:0, y:52,  width:390, height:160 } });
  await page.screenshot({ path: 'pw_metrics.png', clip: { x:0, y:210, width:390, height:320 } });

  await page.evaluate(() => window.scrollTo(0, 580));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'pw_pool.png', fullPage: false });

  await page.evaluate(() => window.scrollTo(0, 1100));
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'pw_table.png', fullPage: false });

  // Open calc via JS (notch might be off-screen)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    var c = document.getElementById('fibCalc');
    var b = document.getElementById('fibBackdrop');
    var n = document.getElementById('fibNotch');
    if (c) c.classList.add('calc-open');
    if (b) b.classList.add('active');
    if (n) n.classList.add('hidden');
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'pw_calc_open.png', fullPage: false });

  console.log('done');
  await browser.close();
})();
