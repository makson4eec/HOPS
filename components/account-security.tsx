import { changePasswordAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "./action-form";

export function AccountSecurity() {
  return <section className="panel account-profile mt-24"><h2>Сменить пароль</h2><p className="muted">После смены пароля остальные сеансы будут завершены. На этом устройстве вы останетесь в кабинете.</p><ActionForm action={changePasswordAction} className="form-stack"><div className="field"><label htmlFor="account-current-password">Текущий пароль</label><input className="input" id="account-current-password" name="currentPassword" type="password" autoComplete="current-password" required /></div><div className="field"><label htmlFor="account-new-password">Новый пароль</label><input className="input" id="account-new-password" name="password" type="password" autoComplete="new-password" required aria-describedby="account-password-hint" /><span className="hint" id="account-password-hint">Длину и символы пароля выбираете вы.</span></div><SubmitButton>Сменить пароль</SubmitButton></ActionForm></section>;
}

