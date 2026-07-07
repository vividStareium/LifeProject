import HabitGroupDetailClient from './habit-group-detail-client';

type HabitGroupDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function HabitGroupDetailPage({ params }: HabitGroupDetailPageProps) {
  const { id } = await params;

  return <HabitGroupDetailClient groupId={id} />;
}
