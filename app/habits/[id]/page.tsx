import HabitDetailClient from './habit-detail-client';

type HabitDetailPageProps = {
  params: {
    id: string;
  };
};

export default function HabitDetailPage({ params }: HabitDetailPageProps) {
  return <HabitDetailClient habitId={params.id} />;
}
