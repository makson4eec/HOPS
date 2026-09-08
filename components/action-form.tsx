"use client";

import { useActionState, useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/types";

export function SubmitButton({ children, className = "button primary", pendingLabel = "Подождите…", disabled = false }: { children: ReactNode; className?: string; pendingLabel?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={pending || disabled} aria-disabled={pending || disabled}>{pending ? pendingLabel : children}</button>;
}

export function ActionForm({ action, children, className = "", resetOnSuccess = false }: { action: (state: ActionState, formData: FormData) => Promise<ActionState>; children: ReactNode; className?: string; resetOnSuccess?: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const submittedValues = useRef<FormData | null>(null);
  const messageId = useId();
  const router = useRouter();

  function rememberValues(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const values = new FormData(form);
    // Passwords are never retained for restoring a rejected form.
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      if (input.name) values.delete(input.name);
    }
    submittedValues.current = values;
  }

  useEffect(() => {
    const form = formRef.current;
    const values = submittedValues.current;
    if (state.success === false && form && values) {
      // React resets uncontrolled inputs after a resolved server action, including
      // validation errors. Restore editable fields so the customer can correct them.
      for (const field of Array.from(form.elements)) {
        if (field instanceof HTMLInputElement) {
          if (!field.name || ["password", "hidden", "file", "submit", "button", "reset", "image"].includes(field.type)) continue;
          if (field.type === "checkbox" || field.type === "radio") {
            field.checked = values.getAll(field.name).some((value) => value === field.value);
          } else if (values.has(field.name)) {
            field.value = String(values.get(field.name) ?? "");
          }
        } else if (field instanceof HTMLSelectElement && field.name) {
          const selected = values.getAll(field.name);
          for (const option of Array.from(field.options)) option.selected = selected.includes(option.value);
        } else if (field instanceof HTMLTextAreaElement && field.name && values.has(field.name)) {
          field.value = String(values.get(field.name) ?? "");
        }
      }
    }
    submittedValues.current = null;
    if (resetOnSuccess && state.success) formRef.current?.reset();
    if (state.redirectTo) router.push(state.redirectTo);
    if (state.success) router.refresh();
  }, [state, resetOnSuccess, router]);
  return <form action={formAction} onSubmit={rememberValues} ref={formRef} className={className} aria-busy={pending} aria-describedby={state.message ? messageId : undefined}>{children}{state.message && <div id={messageId} className={`form-message field full ${state.success ? "form-success" : "form-error"}`} role={state.success ? "status" : "alert"}>{state.message}</div>}</form>;
}
