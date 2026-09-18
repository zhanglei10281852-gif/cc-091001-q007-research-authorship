export const contributionKinds = ['authoring', 'review', 'classroom-validation', 'coordination'];
export const versionStates = ['working', 'frozen', 'authorized', 'published'];
export const disputeStates = ['raised', 'responded', 'resolved', 'withdrawn'];
export const confirmationStates = ['pending', 'agreed', 'objected'];

// 参与者角色：教研主持人、学校统筹人、普通教师
export const userRoles = ['facilitator', 'coordination', 'teacher'];

// 各类贡献的权重建议区间（仅建议，申报时允许 0~1 之间的任意值）
export const weightSuggestionGuide = {
  authoring: [0.35, 0.7],
  review: [0.05, 0.3],
  'classroom-validation': [0.05, 0.35],
  coordination: [0.05, 0.3],
};

// 尚未了结的异议阶段：处于这些阶段的版本不得签发发布摘要
export const openDisputeStates = ['raised', 'responded'];

// 参与者对一个版本可以表达的立场
export const confirmationDecisions = ['agreed', 'objected'];
