const $ = (id) => document.getElementById(id);
const password = $('password');
const error = $('error');
let setup = false;

function fail(message) {
  error.textContent = message;
  error.hidden = false;
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json()).error);
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  if (setup && password.value !== $('again').value) return fail('Parolalar aynı değil.');
  try {
    if (setup) await post('/api/setup', { code: $('code').value, password: password.value });
    else await post('/api/login', { password: password.value });
    location.replace('/');
  } catch (err) {
    fail(err instanceof TypeError ? 'Sunucuya ulaşılamadı. Tekrar deneyin.' : err.message);
    password.select();
  }
});

try {
  setup = (await (await fetch('/api/auth')).json()).needsSetup === true;
} catch {
  // Sunucuya ulaşılamıyorsa giriş denemesi hatayı gösterir.
}
if (setup) {
  for (const id of ['intro', 'code-field', 'again-field']) $(id).hidden = false;
  password.autocomplete = 'new-password';
  $('submit').textContent = 'Parolayı belirle';
  $('code').focus();
}
