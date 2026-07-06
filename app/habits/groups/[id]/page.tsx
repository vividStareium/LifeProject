import HabitGroupDetailClient from './habit-group-detail-client';

type HabitGroupDetailPageProps = {
  params: {
    id: string;
  };
};

export default function HabitGroupDetailPage({ params }: HabitGroupDetailPageProps) {
  return <HabitGroupDetailClient groupId={params.id} />;
}
