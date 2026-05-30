const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('https://carlosduenas101.github.io/Trade-Tracker/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    document.getElementById('loginScreen').hidden = true;
    document.querySelector('.main-content').style.display = 'flex';
  });
  await page.waitForTimeout(500);

  // Read key computed styles
  const info = await page.evaluate(() => {
    var calc = document.getElementById('fibCalc');
    var cs = window.getComputedStyle(calc);
    var rect = calc.getBoundingClientRect();
    return {
      display: cs.display,
      position: cs.position,
      top: cs.top,
      left: cs.left,
      width: cs.width,
      height: cs.height,
      transform: cs.transform,
      zIndex: cs.zIndex,
      background: cs.background,
      overflow: cs.overflow,
      boundingRect: {
        top: rect.top, left: rect.left, 
        width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom
      }
    };
  });
  console.log('CALC STYLES (closed):', JSON.stringify(info, null, 2));

  // Open it and re-read
  await page.evaluate(() => {
    var c = document.getElementById('fibCalc');
    c.classList.add('calc-open');
    document.getElementById('fibBackdrop').classList.add('active');
    document.getElementById('fibNotch').classList.add('hidden');
  });
  await page.waitForTimeout(600);

  const info2 = await page.evaluate(() => {
    var calc = document.getElementById('fibCalc');
    var cs = window.getComputedStyle(calc);
    var rect = calc.getBoundingClientRect();
    return {
      transform: cs.transform,
      left: cs.left,
      width: cs.width,
      boundingRect: {
        top: rect.top, left: rect.left,
        width: rect.width, height: rect.height
      }
    };
  });
  console.log('CALC STYLES (open):', JSON.stringify(info2, null, 2));

  // Highlight the calc element to see it
  await page.evaluate(() => {
    var c = document.getElementById('fibCalc');
    c.style.outline = '4px solid red';
    c.style.background = '#1a1a2e';
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'pw_calc_debug.png', fullPage: false });

  // Also read what CSS is actually applied (check if new CSS is deployed)
  const cssVersion = await page.evaluate(() => {
    var sheets = Array.from(document.styleSheets);
    try {
      for (var s of sheets) {
        if (s.href && s.href.includes('style.css')) {
          var rules = Array.from(s.cssRules);
          // Find the fib-calc rule inside media
          for (var r of rules) {
            if (r.media) {
              var inner = Array.from(r.cssRules || []);
              for (var ir of inner) {
                if (ir.selectorText && ir.selectorText.includes('fib-calc') && !ir.selectorText.includes('open') && !ir.selectorText.includes('header') && !ir.selectorText.includes('body') && !ir.selectorText.includes('btn') && !ir.selectorText.includes('icon') && !ir.selectorText.includes('close') && !ir.selectorText.includes('back') && !ir.selectorText.includes('notch')) {
                  return { selector: ir.selectorText, text: ir.cssText.substring(0, 300) };
                }
              }
            }
          }
        }
      }
    } catch(e) { return 'cors error: ' + e.message; }
    return 'not found';
  });
  console.log('CSS in use:', JSON.stringify(cssVersion));

  await browser.close();
})();
