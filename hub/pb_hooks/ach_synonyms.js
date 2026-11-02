// Search synonyms. Each line is one group: searching for any
// word in a group also finds the others. Matching is case-insensitive and
// whole-term (a query term must equal a group word). Edit freely; the hub
// reads this file on every search (no restart needed with --hooksWatch).
// The Chinese words are language support for Chinese queries.
module.exports = [
  ["成本", "花费", "费用", "开销", "cost", "costs", "spend"],
  ["预算", "budget"],
  ["批量", "batch", "batching"],
  ["上线", "发布", "deploy", "ship", "release"],
  ["回滚", "rollback", "revert"],
  ["测试", "test", "tests", "testing"],
  ["缺陷", "bug", "bugs"],
  ["需求", "requirement", "spec"],
  ["延迟", "latency"],
  ["文档", "doc", "docs"],
]
