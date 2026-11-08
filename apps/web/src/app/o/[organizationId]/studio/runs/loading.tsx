import { PageHead } from '@/components/ui';
export default function Loading() {
  return (
    <>
      <PageHead title="Workflow runs" />
      <p role="status" aria-busy="true">
        Reading current workflow records…
      </p>
    </>
  );
}
