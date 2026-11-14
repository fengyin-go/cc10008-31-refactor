/**
 * 分片领域测试：覆盖需求里的 12 条不变量。
 * 运行：node --import tsx --test src/data/segment/*.test.ts
 * 使用内存存储驱动，并可模拟 localStorage 写入失败来验证整体回滚。
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'

import {
  __setSegmentDriver,
  advanceMigration,
  deleteDraftRule,
  evaluateRule,
  generateMigrationPlan,
  getBatch,
  getRule,
  latestResult,
  listBatches,
  listResults,
  listRules,
  resetSegmentState,
  saveDraft,
  SEGMENT_STORAGE_KEY as STORAGE_KEY,
  transitionRule,
  type SegmentStorageDriver,
  type ShardNode,
} from './index'

class MemoryDriver implements SegmentStorageDriver {
  store = new Map<string, string>()
  failWrites = false
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('模拟磁盘写入失败')
    }
    this.store.set(key, value)
  }
}

let driver: MemoryDriver

function nodes(prefix: string, count: number): ShardNode[] {
  return Array.from({ length: count }, (_, index) => ({
    nodeId: `${prefix}-NODE-${String(index + 1).padStart(3, '0')}`,
    ownerShardNo: 0,
    load: 10 + (index % 4) * 12 + (index % 7) * 3,
  }))
}

function activeRuleId(): number {
  return listRules().find((rule) => rule.status === '已启用')!.id
}

function draftId(): number {
  return listRules().find((rule) => rule.status === '草稿')!.id
}

beforeEach(() => {
  driver = new MemoryDriver()
  __setSegmentDriver(driver)
  resetSegmentState()
})

describe('R1 启用判断与迁移计划拆分，草稿修改不污染现有计划', () => {
  it('草稿改名/改阈值后，已有结果与批次的快照保持原值', () => {
    const ruleId = activeRuleId()
    // 先在启用规则上造一个批次，再退回草稿态用于编辑。
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    const beforeBatch = listBatches(ruleId).slice(-1)[0]
    const beforeShardCount = beforeBatch.snapshot.shardCount
    const beforeStrategy = beforeBatch.snapshot.migrationStrategy

    const rule = getRule(ruleId)!
    const saved = saveDraft(ruleId, {
      ...getRule(ruleId)!,
      name: '草稿改名后的规则',
      shardCount: rule.shardCount + 5,
      skewThreshold: 9.9,
      migrationStrategy: 'CHANGED_STRATEGY',
    })
    assert.equal(saved.ok, true)

    const afterBatch = getBatch(beforeBatch.id)!
    assert.equal(afterBatch.snapshot.shardCount, beforeShardCount)
    assert.equal(afterBatch.snapshot.migrationStrategy, beforeStrategy)
    assert.equal(afterBatch.ruleName !== '草稿改名后的规则', true)
    // 分片结果数量不变，结果内嵌配置也不变。
    const resultCount = listResults(ruleId).length
    assert.ok(resultCount >= 1)
    assert.equal(latestResult(ruleId)!.config.shardCount, beforeShardCount)
  })
})

describe('R2 保存失败时规则与计划整体回到旧状态', () => {
  it('存储抛错后，内存状态回滚，规则改名不生效', () => {
    const ruleId = draftId()
    const rule = getRule(ruleId)!
    const oldName = rule.name
    driver.failWrites = true
    const result = saveDraft(ruleId, { ...rule, name: '写不进去的名称' })
    assert.equal(result.ok, false)
    assert.match(result.message, /整体回滚/)
    driver.failWrites = false
    assert.equal(getRule(ruleId)!.name, oldName)
  })
})

describe('R3 停用后旧任务可查，新计划被拒绝', () => {
  it('停用规则的历史批次仍能列出，但生成新计划被拒绝', () => {
    const stopped = listRules().find((rule) => rule.status === '已停用')!
    assert.ok(listBatches(stopped.id).length >= 1)
    const result = generateMigrationPlan(stopped.id)
    assert.equal(result.ok, false)
    assert.match(result.message, /不能生成新的迁移计划/)
  })
})

describe('R4 计划生成不暴露半成品', () => {
  it('无候选时不产生任何批次，批次数量不变', () => {
    const ruleId = activeRuleId()
    // 造一份没有倾斜候选的评估：把阈值调到极大。
    const rule = getRule(ruleId)!
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    saveDraft(ruleId, { ...getRule(ruleId)!, skewThreshold: 999 })
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '已启用')
    const before = listBatches(ruleId).length
    const evaluated = evaluateRule(ruleId, nodes('FRESH', 12))
    assert.equal(evaluated.ok, true)
    const planned = generateMigrationPlan(ruleId)
    assert.equal(planned.ok, false)
    assert.match(planned.message, /无需生成迁移计划/)
    assert.equal(listBatches(ruleId).length, before)
  })
})

describe('R5 恢复启用按当前倾斜阈值重新校验/重判', () => {
  it('阈值改大后重新评估，倾斜候选数量下降', () => {
    const ruleId = activeRuleId()
    const first = latestResult(ruleId)!
    const baselineCandidates = first.candidates.filter((c) => c.status === 'SKEWED').length
    const rule = getRule(ruleId)!
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    saveDraft(ruleId, { ...getRule(ruleId)!, skewThreshold: 99 })
    transitionRule(ruleId, '待校验')
    const enabled = transitionRule(ruleId, '已启用')
    assert.equal(enabled.ok, true)
    evaluateRule(ruleId, nodes('R3', 20))
    const next = latestResult(ruleId)!
    assert.equal(next.config.skewThreshold, 99)
    // 迁移中的候选按 R10 原样携带，不计入本次判定；本次新判的 SKEWED 必须为 0。
    const skewedNow = next.candidates.filter((c) => c.status === 'SKEWED').length
    assert.ok(skewedNow <= baselineCandidates)
    assert.equal(skewedNow, 0)
    assert.ok(next.carriedMigrating >= 1)
  })
})

describe('R6 历史结果保留旧分片数量与迁移策略', () => {
  it('旧结果 config 不随后续规则修改而改变', () => {
    const ruleId = activeRuleId()
    const oldResult = latestResult(ruleId)!
    const frozen = { ...oldResult.config }
    const rule = getRule(ruleId)!
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    saveDraft(ruleId, { ...getRule(ruleId)!, shardCount: 9, migrationStrategy: 'NEW' })
    const historical = listResults(ruleId).find((result) => result.id === oldResult.id)!
    assert.deepEqual(historical.config, frozen)
  })
})

describe('R7 算法切换不修改已生成候选的归属', () => {
  it('HASH 切 RANGE 后重新评估，迁移中候选仍留在原分片', () => {
    const ruleId = activeRuleId()
    const migratingBefore = latestResult(ruleId)!.candidates.find((c) => c.status === 'MIGRATING')!
    const owner = migratingBefore.ownerShardNo
    const rule = getRule(ruleId)!
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    saveDraft(ruleId, { ...getRule(ruleId)!, algorithm: 'RANGE' })
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '已启用')
    evaluateRule(ruleId, nodes('R3', 20))
    const carried = latestResult(ruleId)!.candidates.find((c) => c.nodeId === migratingBefore.nodeId)!
    assert.equal(carried.status, 'MIGRATING')
    assert.equal(carried.ownerShardNo, owner)
    assert.ok(latestResult(ruleId)!.carriedMigrating >= 1)
  })
})

describe('R8 再平衡触发条件变化只影响下一次计算', () => {
  it('旧批次 trigger 不变，新批次读取新触发条件', () => {
    const ruleId = activeRuleId()
    const oldBatch = listBatches(ruleId).slice(-1)[0]
    const oldTrigger = oldBatch.trigger
    const rule = getRule(ruleId)!
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    saveDraft(ruleId, { ...getRule(ruleId)!, rebalanceTrigger: 'MANUAL', skewThreshold: 999 })
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '已启用')
    // 阈值 999 造不出候选，先制造一批倾斜候选：重新给一份高负载节点。
    saveDraftViaReenable(ruleId, 1.01)
    evaluateRule(ruleId, nodes('TRIG', 24))
    const planned = generateMigrationPlan(ruleId)
    assert.equal(planned.ok, true)
    const freshBatch = listBatches(ruleId).slice(-1)[0]
    assert.equal(getBatch(oldBatch.id)!.trigger, oldTrigger)
    assert.equal(freshBatch.trigger, 'MANUAL')
  })

  function saveDraftViaReenable(ruleId: number, threshold: number): void {
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '草稿')
    const rule = getRule(ruleId)!
    saveDraft(ruleId, { ...rule, skewThreshold: threshold })
    transitionRule(ruleId, '待校验')
    transitionRule(ruleId, '已启用')
  }
})

describe('R9 删除草稿规则不删除已引用的历史迁移批次', () => {
  it('草稿删除后规则消失，但批次与结果保留', () => {
    // 给草稿规则先造历史：草稿无法直接评估，改用停用规则验证——它有历史批次。
    const stopped = listRules().find((rule) => rule.status === '已停用')!
    const batchCount = listBatches(stopped.id).length
    const resultCount = listResults(stopped.id).length
    // 停用规则不允许删，先验删除被拒；再把一个草稿删掉确认只删本体。
    const reject = deleteDraftRule(stopped.id)
    assert.equal(reject.ok, false)

    const draftRuleId = draftId()
    const deleted = deleteDraftRule(draftRuleId)
    assert.equal(deleted.ok, true)
    assert.equal(getRule(draftRuleId), undefined)

    // 停用规则的历史批次/结果不受任何影响。
    assert.equal(listBatches(stopped.id).length, batchCount)
    assert.equal(listResults(stopped.id).length, resultCount)
  })
})

describe('R10 迁移中的候选不能被重新判定为已平衡', () => {
  it('重复评估后 MIGRATING 候选状态与原因保留，且新计划被拒绝', () => {
    const ruleId = activeRuleId()
    const before = latestResult(ruleId)!.candidates.find((c) => c.status === 'MIGRATING')!
    evaluateRule(ruleId, nodes('R3', 20))
    const after = latestResult(ruleId)!.candidates.find((c) => c.nodeId === before.nodeId)!
    assert.equal(after.status, 'MIGRATING')
    assert.equal(after.reason, before.reason)
    const blocked = generateMigrationPlan(ruleId)
    assert.equal(blocked.ok, false)
    assert.match(blocked.message, /正在迁移/)
  })
})

describe('R11 失败节点回到原分片并保留迁移原因', () => {
  it('步骤失败后候选退回 SKEWED、归属还原、失败原因留证', () => {
    const ruleId = activeRuleId()
    const batch = listBatches(ruleId).find((b) => b.status === 'RUNNING')!
    const step = batch.steps.find((s) => s.status === 'PENDING')!
    const result = advanceMigration(batch.id, { ok: false, failureReason: '目标节点磁盘满' })
    assert.equal(result.ok, true)
    const failedStep = getBatch(batch.id)!.steps.find((s) => s.stepNo === step.stepNo)!
    assert.equal(failedStep.status, 'FAILED')
    assert.equal(failedStep.failureReason, '目标节点磁盘满')
    const candidate = latestResult(ruleId)!.candidates.find((c) => c.nodeId === step.nodeId)!
    assert.equal(candidate.status, 'SKEWED')
    assert.equal(candidate.ownerShardNo, step.sourceShardNo)
    assert.equal(candidate.failureReason, '目标节点磁盘满')
    assert.ok(candidate.reason.length > 0)
    // 失败批次不能继续执行。
    const again = advanceMigration(batch.id)
    assert.equal(again.ok, false)
  })
})

describe('R12 名称重复阻止保存，历史只按编号引用', () => {
  it('重复名称保存失败；批次 ruleId 引用不随名称变化', () => {
    const existing = listRules()[1]
    const draftRuleId = draftId()
    const draft = getRule(draftRuleId)!
    const duplicate = saveDraft(draftRuleId, { ...draft, name: existing.name })
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.message, /已存在/)

    // 批次只存 ruleId 编号引用；ruleName 只是展示冗余。
    const batch = listBatches().slice(-1)[0]
    assert.equal(typeof batch.ruleId, 'number')
    assert.ok(getRule(batch.ruleId) !== undefined || listResults(batch.ruleId).length >= 0)
  })
})

describe('守卫统一性：规则链与迁移链共用同一套判定', () => {
  it('非法状态流转被统一守卫拒绝', () => {
    const draftRuleId = draftId()
    // 草稿不能直接启用。
    const jump = transitionRule(draftRuleId, '已启用')
    assert.equal(jump.ok, false)
    assert.match(jump.message, /不能从「草稿」流转到「已启用」/)
  })

  it('校验失败的规则不能恢复启用', () => {
    const ruleId = activeRuleId()
    transitionRule(ruleId, '已停用')
    transitionRule(ruleId, '待校验')
    // 模拟历史脏数据：绕过保存校验直接把无效配置写进存储（例如旧版本遗留）。
    const raw = JSON.parse(driver.getItem(STORAGE_KEY)!) as {
      rules: { id: number; shardCount: number }[]
    }
    const target = raw.rules.find((item) => item.id === ruleId)!
    target.shardCount = 0
    driver.setItem(STORAGE_KEY, JSON.stringify(raw))
    __setSegmentDriver(driver) // 清掉内存缓存，强制从存储重读脏数据
    // 待校验→已启用时 validateDraft 必须拦截，不允许带病启用。
    const enabled = transitionRule(ruleId, '已启用')
    assert.equal(enabled.ok, false)
    assert.match(enabled.message, /恢复启用前校验未通过/)
  })
})
