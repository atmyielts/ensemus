import {
  Table,
  TableCaption,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import Link from 'next/link';
import type { ImportedArchiveFileView } from '@ensemus/application';
import { formatDateTime } from './ui';

export function ImportedArchiveFiles({
  organizationId,
  importId,
  files,
  after,
}: {
  organizationId: string;
  importId: string;
  files: readonly ImportedArchiveFileView[];
  after?: string;
}) {
  const base = `/api/v1/organizations/${organizationId}/imports/${importId}/files`;
  return (
    <>
      <p>
        These files are kept separately because their original input permissions could not be
        proven. They are not attached to work and are never used by an assistant automatically.
      </p>
      <p>
        Download a ready file to review it. If appropriate, attach it yourself using Files on the{' '}
        <Link href={`/o/${organizationId}/work`}>right piece of work</Link>. This creates a new
        human upload; it does not approve the archive's original provenance.
      </p>
      {files.length === 0 ? (
        <p className="muted">
          No archived files are ready for this account. Files can also be blocked by current
          permissions or awaiting cleanup.
        </p>
      ) : (
        <div className="table-wrap">
          <Table>
            <TableCaption className="visually-hidden">Archived files held for review</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">File</TableHead>
                <TableHead scope="col">Received</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow key={file.sourceArtifactId}>
                  <TableHead scope="row">
                    {file.name ?? 'Protected archived file'}
                    <div className="muted">
                      {new Intl.NumberFormat('en').format(file.sizeBytes)} bytes
                    </div>
                  </TableHead>
                  <TableCell>{formatDateTime(file.createdAt)}</TableCell>
                  <TableCell>
                    {file.state === 'purged'
                      ? 'Removed'
                      : file.state === 'closing'
                        ? 'Awaiting verified cleanup'
                        : file.state !== 'quarantined'
                          ? 'Operator attention needed'
                          : file.reviewable
                            ? 'Awaiting your review'
                            : 'Blocked by current permissions'}
                  </TableCell>
                  <TableCell>
                    {file.reviewable ? (
                      <a href={`${base}/${file.sourceArtifactId}/download`}>Download to review</a>
                    ) : (
                      <span className="muted">Not available for download</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {files.length === 50 && (
        <p>
          <Link
            href={`/o/${organizationId}/data?files_after=${files.at(-1)!.sourceArtifactId}#data-files`}
          >
            More archived files
          </Link>
        </p>
      )}
      {after && (
        <p>
          <Link href={`/o/${organizationId}/data#data-files`}>Back to the first files</Link>
        </p>
      )}
    </>
  );
}
