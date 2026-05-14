import { FlowWorkbench } from '../../../components/flow-workbench';

export default async function FlowPage({ params }: { params: Promise<{ id: string }> }) {
  const resolved = await params;
  return <FlowWorkbench flowId={resolved.id} />;
}
