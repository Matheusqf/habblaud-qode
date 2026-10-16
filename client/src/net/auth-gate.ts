// B4 L1: gate mínimo da SPA. Com HABBLAUD_AUTH desligado, /api/auth/status dá {authRequired:false} (404 de servidores antigos também é aceite).
// Com auth ligada e sem sessão, mostra um formulário de senha e só arranca o escritório depois do login.

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
}

export async function fetchAuthStatus(f: typeof fetch = fetch): Promise<AuthStatus> {
  try {
    const res = await f('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 404) return { authRequired: false, authenticated: true };
    if (!res.ok) return { authRequired: true, authenticated: false };
    return (await res.json()) as AuthStatus;
  } catch {
    return { authRequired: false, authenticated: true };
  }
}

/** Resolve quando o escritório pode arrancar. */
export async function ensureAuthenticated(root: HTMLElement): Promise<void> {
  const st = await fetchAuthStatus();
  if (!st.authRequired || st.authenticated) return;
  await new Promise<void>((resolve) => {
    const box = document.createElement('form');
    box.className = 'auth-gate';
    box.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;background:#111;color:#eee;z-index:9999;font:14px system-ui';
    const title = document.createElement('div');
    title.textContent = 'QODE Office — entrar';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = 'Senha';
    input.style.cssText = 'padding:8px;min-width:240px';
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Entrar';
    const msg = document.createElement('div');
    msg.setAttribute('role', 'alert');
    box.append(title, input, btn, msg);
    root.appendChild(box);
    input.focus();
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.textContent = '';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ password: input.value }),
        });
        input.value = '';
        if (res.ok) {
          box.remove();
          resolve();
          return;
        }
        msg.textContent = res.status === 429 ? 'Muitas tentativas. Tente mais tarde.' : 'Credenciais inválidas.';
      } catch {
        msg.textContent = 'Falha de rede.';
      }
      btn.disabled = false;
    });
  });
}
