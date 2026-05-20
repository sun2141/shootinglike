import type { FormResult } from "./form";

export function generateFeedback(form: FormResult, speedKmh: number): string[] {
  const feedbacks: string[] = [];

  // Form feedback
  if (form.kneeAngle < 130) {
    feedbacks.push("디딤발이 너무 많이 굽혀졌습니다. 무릎을 조금 더 펴서 지면을 견고하게 지탱하세요.");
  } else if (form.kneeAngle > 160) {
    feedbacks.push("디딤발이 너무 꼿꼿합니다. 무릎을 살짝 굽혀 충격을 흡수하고 밸런스를 잡으세요.");
  } else {
    feedbacks.push("디딤발의 각도가 매우 안정적입니다.");
  }

  if (form.torsoLeanAngle < 10) {
    feedbacks.push("상체가 너무 서 있습니다. 공이 뜰 확률이 높으니 타격 순간 상체를 앞으로 살짝 덮어주세요.");
  } else if (form.torsoLeanAngle > 35) {
    feedbacks.push("상체가 너무 많이 기울어졌습니다. 코어에 힘을 주고 밸런스를 유지하세요.");
  } else {
    feedbacks.push("상체의 기울기와 밸런스가 이상적입니다.");
  }

  // Speed feedback
  if (speedKmh > 100) {
    feedbacks.push("프로 수준의 놀라운 구속입니다! 임팩트가 매우 훌륭합니다.");
  } else if (speedKmh < 60) {
    feedbacks.push("스윙 속도를 더 올려보세요. 공의 중심을 정확히 타격하면 구속이 상승합니다.");
  }

  return feedbacks;
}
