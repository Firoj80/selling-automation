async function assertComposerText(page, editor, text) {
  const actual = await page.evaluate(el => el.value === undefined ? el.innerText : el.value, editor);
  const normalize = value => String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
  if (normalize(actual) !== normalize(text)) throw new Error('Composer text does not match the complete intended caption; submission blocked');
}
async function writeComposerText(page, editor, text) {
  if (!text?.trim()) throw new Error('A nonempty caption is required');
  await editor.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  // One native text insertion avoids dropped keystrokes while React rerenders.
  await page.keyboard.sendCharacter(text);
  await page.waitForFunction((el, expected) => {
    const normalize = value => String(value || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    return el.isConnected && normalize(el.value === undefined ? el.innerText : el.value) === normalize(expected);
  }, { timeout: 8000 }, editor, text);
  await assertComposerText(page, editor, text);
}
module.exports = { writeComposerText, assertComposerText };
