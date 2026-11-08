import { CodeFields, FactorError } from './code-fields';
import { SubmitButton } from '../submit-button';

/** Each server page supplies its own already-bound action and admission policy. */
export function IdentityConfirmationForm({
  action,
  next,
  error,
}: {
  action: (form: FormData) => Promise<void>;
  next: string;
  error?: string | undefined;
}) {
  return (
    <>
      <FactorError code={error} />
      <form className="fields" action={action}>
        <input type="hidden" name="next" value={next} />
        <CodeFields />
        <div>
          <SubmitButton working="Confirming">Confirm and continue</SubmitButton>
        </div>
      </form>
    </>
  );
}
