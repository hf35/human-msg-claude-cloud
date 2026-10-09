import { expect, test, type Browser, type Page } from '@playwright/test';

/** A person in their own browser context: own cookies, own storage, like an incognito window. */
async function signIn(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Name of the test user').fill(`${name}-${Date.now()}`);
  await page.getByRole('button', { name: 'Sign in without Google' }).click();
  await expect(page.getByTestId('who')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeVisible();
  return page;
}

test('a question reaches another person and the answer comes back with the question', async ({
  browser,
}) => {
  const answerer = await signIn(browser, 'answerer');
  // No need to wait for the answerer's socket: a question asked before it is open waits in the
  // queue and is handed over the moment it connects
  const author = await signIn(browser, 'author');

  // The author asks and sees that someone is being looked for
  const question = 'What colour is the sky today?';
  await author.getByRole('textbox', { name: 'Ask a question' }).fill(question);
  await author.getByRole('button', { name: 'Send' }).click();
  await expect(author.getByTestId('pending')).toHaveText(question);

  // The question appears on the other person's screen without a reload, from an alias only
  await expect(answerer.getByTestId('incoming')).toHaveText(question);
  await expect(answerer.getByRole('heading', { level: 2 })).toContainText('Question from');
  await expect(answerer.getByTestId('countdown')).toContainText('Time left');

  // The answerer replies
  const reply = 'Blue, with a few clouds.';
  await answerer.getByRole('textbox', { name: 'Write your answer…' }).fill(reply);
  await answerer.getByRole('button', { name: 'Answer' }).click();
  await expect(answerer.getByRole('textbox', { name: 'Ask a question' })).toBeVisible();

  // The author gets the answer together with the original question
  await expect(author.getByTestId('answer-question')).toHaveText(question);
  await expect(author.getByTestId('answer-text')).toHaveText(reply);
  await expect(author.getByTestId('pending')).toHaveCount(0);

  // Both sides see the exchange in their history
  await author.getByRole('button', { name: 'Show history' }).click();
  await expect(author.getByTestId('history-answer')).toHaveText(reply);
  await answerer.getByRole('button', { name: 'Show history' }).click();
  await expect(answerer.getByTestId('history-given')).toContainText(question);
});
