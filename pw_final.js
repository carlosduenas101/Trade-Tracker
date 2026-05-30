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
    document.getElementById('bulkDeleteBtn').hidden = true;
    ['metricWinRate','metricPnl','metricTotalLosses','metricDrawdown',
     'metricMaxProfit','metricRR','metricStreak','metricTotal',
     'metricAvgRoe','metricAvgEntries','metricAvgDuration','metricAvgPnl'].forEach((id,i) => {
      var el = document.getElementById(id);
      if (el) { el.textContent = i%2===0 ? '+$420' : '68%'; el.classList.remove('skeleton'); }
    });
  });
  await page.waitForTimeout(500);

  // Main layout closed
  await page.screenshot({ path: 'pw_final_closed.png', fullPage: false });

  // Open the calculator
  await page.evaluate(() => {
    document.getElementById('fibCalc').classList.add('calc-open');
    document.getElementById('fibBackdrop').classList.add('active');
    document.getElementById('fibNotch').classList.add('hidden');
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'pw_final_open.png', fullPage: false });

  console.log('done');
  await browser.close();
})();
