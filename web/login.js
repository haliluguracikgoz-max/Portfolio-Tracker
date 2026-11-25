const form = document.getElementById('login');
const password = document.getElementById('password');
const error = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  let message = 'Sunucuya ulaşılamadı. Tekrar deneyin.';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (res.ok) {
      location.replace('/');
      return;
    }
    message = (await res.json()).error;
  } catch {
    // Varsayılan mesaj gösterilir.
  }
  error.textContent = message;
  error.hidden = false;
  password.select();
});
