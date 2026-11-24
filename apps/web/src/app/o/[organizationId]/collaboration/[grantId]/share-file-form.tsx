import { randomUUID } from 'node:crypto';
import { KeptInput } from '@/components/kept-field';
import { SubmitButton } from '@/components/submit-button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

export function ShareFileForm({
  action,
  grantId,
  files,
}: {
  action: (data: FormData) => Promise<void>;
  grantId: string;
  files: readonly { id: string; name: string; classification: string }[];
}) {
  return (
    <section className="card min-w-0" aria-labelledby="send-shared-file">
      <h2 id="send-shared-file">Send a file</h2>
      {files.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          No recent work files are available within this grant’s classification limit.
        </p>
      ) : (
        <form action={action} className="grid max-w-xl min-w-0 gap-3">
          <input type="hidden" name="operation" value="send" />
          <input type="hidden" name="kind" value="artifact" />
          <input type="hidden" name="requestKey" value={randomUUID()} />
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="share-picked-file">Work file</Label>
            <NativeSelect id="share-picked-file" name="artifactId" required defaultValue="">
              <option value="" disabled>
                Choose a file
              </option>
              {files.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.name} · {file.classification}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="share-file-title">File name to share</Label>
            <KeptInput
              keep={'share-file-title-' + grantId}
              name="title"
              id="share-file-title"
              maxLength={200}
              required
            />
          </div>
          <div>
            <SubmitButton working="Queuing file">Queue file</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}
