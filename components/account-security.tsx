import { changePasswordAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "./action-form";

export function AccountSecurity() {
  return <section className="panel account-profile mt-24"><h2>Сменить пароль</h2><p className="muted">После смены пароля остальные сеансы будут завершены. На этом устройстве вы останетесь в кабинете.</p><ActionForm action={changePasswordAction} className="form-stack"><div className="field"><label htmlFor="account-current-password">Текущий пароль</label><input className="input" id="account-current-password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></div><div className="field"><label htmlFor="account-new-password">Новый пароль</label><input className="input" id="account-new-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required aria-describedby="account-password-hint" /><span className="hint" id="account-password-hint">От 12 до 128 символов. Выберите пароль, который не используете на других сайтах.</span></div><SubmitButton>Сменить пароль</SubmitButton></ActionForm></section>;
}

