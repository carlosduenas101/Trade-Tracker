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
      if (el) { el.textContent = i%2===0 ? '+$420' : '68%'; el.classList.remove('skeleton'); }
    });
    // hide delete button properly
    document.getElementById('bulkDeleteBtn').hidden = true;
  });
  await page.waitForTimeout(500);

  // Full viewport screenshot to see notch & overall layout
  await page.screenshot({ path: 'pw_full.png', fullPage: false });

  // Open calc without backdrop blur so we can see it clearly
  await page.evaluate(() => {
    var c = document.getElementById('fibCalc');
    var b = document.getElementById('fibBackdrop');
    var n = document.getElementById('fibNotch');
    if (b) b.style.backdropFilter = 'none'; // remove blur to see calc clearly
    if (b) b.style.background = 'rgba(0,0,0,0.4)';
    if (c) c.classList.add('calc-open');
    if (b) b.classList.add('active');
    if (n) n.classList.add('hidden');
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'pw_calc_clear.png', fullPage: false });

  console.log('done');
  await browser.close();
})();
