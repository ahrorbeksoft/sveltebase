// Shared assertion fixture: the server test verifies this against actual render output,
// and the browser test hydrates the identical markup with the identical load data.
export const authHtml = '<!--[--><p data-user="">Alice</p> <p data-initial="">alice</p> <p data-role="">editor</p> <p data-session="">alice</p> <p data-flat="">editor</p> <p data-ready="">true</p> <p data-authenticated="">true</p> <p data-verifying="">false</p><!--]-->';
export const loadData = { user: { id: 'alice', name: 'Alice' }, claims: { role: 'editor' } };
