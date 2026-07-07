import HabitDetailClient from './habit-detail-client';

type HabitDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function HabitDetailPage({ params }: HabitDetailPageProps) {
  const { id } = await params;

  return <HabitDetailClient habitId={id} />;
}
