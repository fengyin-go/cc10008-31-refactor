import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  advanceMigration,
  deleteDraftRule,
  evaluateRule,
  generateMigrationPlan,
  getRule,
  listBatches,
  listResults,
  listRules,
  resetSegmentState,
  saveDraft,
  transitionRule,
  type MigrationBatch,
  type SegmentActionResult,
  type SegmentRule,
  type SegmentRuleDraft,
  type ShardNode,
  type ShardResult,
} from '@/data/segment'

const ALGORITHMS = ['HASH', 'RANGE', 'ROUND_ROBIN'] as const
const TRIGGERS = ['AUTO', 'MANUAL'] as const

/** 评估用的样本节点：页面不直接改领域，只提供输入，归属与倾斜由领域层计算。 */
function buildSampleNodes(ruleId: number): ShardNode[] {
  return Array.from({ length: 20 }, (_, index) => ({
    nodeId: `RULE${ruleId}-NODE-${String(index + 1).padStart(3, '0')}`,
    ownerShardNo: 0,
    load: 10 + (index % 4) * 12 + (index % 7) * 3,
  }))
}

function emptyDraft(): SegmentRuleDraft {
  return {
    name: '',
    targetDataset: '',
    shardField: '',
    algorithm: 'HASH',
    shardCount: 4,
    skewThreshold: 1.3,
    rebalanceTrigger: 'AUTO',
    migrationStrategy: 'COPY_FIRST',
  }
}

export default function SegmentView() {
  const [rules, setRules] = useState<SegmentRule[]>([])
  const [results, setResults] = useState<ShardResult[]>([])
  const [batches, setBatches] = useState<MigrationBatch[]>([])
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null)
  const [draft, setDraft] = useState<SegmentRuleDraft>(emptyDraft())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [message, setMessage] = useState<SegmentActionResult | null>(null)

  const reload = useCallback(() => {
    setRules(listRules())
    setResults(listResults())
    setBatches(listBatches())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const selectedRule = useMemo(
    () => (selectedRuleId === null ? undefined : getRule(selectedRuleId)),
    [selectedRuleId, rules],
  )
  const ruleResults = useMemo(
    () => (selectedRuleId === null ? [] : results.filter((item) => item.ruleId === selectedRuleId)),
    [results, selectedRuleId],
  )
  const ruleBatches = useMemo(
    () => (selectedRuleId === null ? [] : batches.filter((item) => item.ruleId === selectedRuleId)),
    [batches, selectedRuleId],
  )

  function report(result: SegmentActionResult): void {
    setMessage(result)
    if (result.ok) {
      reload()
    }
  }

  function startCreate(): void {
    setEditingId(null)
    setDraft(emptyDraft())
    setMessage(null)
  }

  function startEdit(rule: SegmentRule): void {
    setEditingId(rule.id)
    setDraft({ ...rule })
    setMessage(null)
  }

  function handleSave(): void {
    report(saveDraft(editingId, draft))
  }

  const ruleColumns = ['名称', '编号', '算法', '分片数量', '倾斜阈值', '触发', '迁移策略', '状态']

  return (
    <section className="page" data-module="segment">
      <header className="page-head">
        <div>
          <h2>数据分片管理</h2>
          <p className="page-desc">
            规则启用判断、分片倾斜评估与再平衡迁移计划是三条独立链路：改草稿不污染已有结果与计划，
            历史结果与批次按规则编号引用并冻结生成时配置。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={startCreate}>
            新建分片规则
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              resetSegmentState()
              report({ ok: true, message: '已恢复分片领域初始数据' })
            }}
          >
            重置示例数据
          </button>
        </div>
      </header>

      {message && (
        <p className={message.ok ? 'ok-text' : 'error-text'} role="status">
          {message.message}
        </p>
      )}

      {/* 链路一：规则命令链——草稿保存、状态流转、删除，与迁移计划完全分开 */}
      <h3 className="panel-title">① 分片规则（启用判断独立）</h3>
      <table className="data-table">
        <thead>
          <tr>
            {ruleColumns.map((column) => <th key={column}>{column}</th>)}
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} className={selectedRuleId === rule.id ? 'row-selected' : ''}>
              <td>{rule.name}</td>
              <td>{rule.code}</td>
              <td>{rule.algorithm}</td>
              <td>{rule.shardCount}</td>
              <td>{rule.skewThreshold}</td>
              <td>{rule.rebalanceTrigger}</td>
              <td>{rule.migrationStrategy}</td>
              <td>{rule.status}</td>
              <td className="row-actions">
                <button className="link" type="button" onClick={() => setSelectedRuleId(rule.id)}>
                  查看结果
                </button>
                {rule.status === '草稿' && (
                  <button className="link" type="button" onClick={() => startEdit(rule)}>
                    编辑草稿
                  </button>
                )}
                {rule.status === '草稿' && (
                  <button className="link" type="button" onClick={() => transition(rule, '待校验')}>
                    提交校验
                  </button>
                )}
                {rule.status === '待校验' && (
                  <button className="link" type="button" onClick={() => transition(rule, '已启用')}>
                    启用分片
                  </button>
                )}
                {rule.status === '待校验' && (
                  <button className="link" type="button" onClick={() => transition(rule, '草稿')}>
                    退回草稿
                  </button>
                )}
                {rule.status === '已启用' && (
                  <button className="link" type="button" onClick={() => transition(rule, '已停用')}>
                    停用分片
                  </button>
                )}
                {rule.status === '已停用' && (
                  <button className="link" type="button" onClick={() => transition(rule, '待校验')}>
                    重新校验
                  </button>
                )}
                {rule.status === '草稿' && (
                  <button className="link danger" type="button" onClick={() => report(deleteDraftRule(rule.id))}>
                    删除草稿
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 草稿编辑区：只改规则本体，保存失败整体回滚，绝不触碰已有结果/批次 */}
      <div className="draft-panel">
        <h4 className="panel-title">{editingId === null ? '新建草稿规则' : `编辑草稿 #${editingId}`}</h4>
        <div className="form-grid">
          <label>
            <span>规则名称（不可重复）</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            <span>目标数据集</span>
            <input value={draft.targetDataset} onChange={(e) => setDraft({ ...draft, targetDataset: e.target.value })} />
          </label>
          <label>
            <span>分片字段</span>
            <input value={draft.shardField} onChange={(e) => setDraft({ ...draft, shardField: e.target.value })} />
          </label>
          <label>
            <span>分片算法</span>
            <select
              value={draft.algorithm}
              onChange={(e) => setDraft({ ...draft, algorithm: e.target.value as SegmentRuleDraft['algorithm'] })}
            >
              {ALGORITHMS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>分片数量</span>
            <input
              type="number"
              value={draft.shardCount}
              onChange={(e) => setDraft({ ...draft, shardCount: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>数据倾斜阈值</span>
            <input
              type="number"
              step="0.1"
              value={draft.skewThreshold}
              onChange={(e) => setDraft({ ...draft, skewThreshold: Number(e.target.value) })}
            />
          </label>
          <label>
            <span>再平衡触发</span>
            <select
              value={draft.rebalanceTrigger}
              onChange={(e) => setDraft({ ...draft, rebalanceTrigger: e.target.value as SegmentRuleDraft['rebalanceTrigger'] })}
            >
              {TRIGGERS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>
            <span>迁移策略</span>
            <input
              value={draft.migrationStrategy}
              onChange={(e) => setDraft({ ...draft, migrationStrategy: e.target.value })}
            />
          </label>
        </div>
        <div className="row-actions">
          <button className="btn primary" type="button" onClick={handleSave}>保存草稿</button>
          <button className="btn ghost" type="button" onClick={startCreate}>清空表单</button>
        </div>
      </div>

      {selectedRule && (
        <>
          {/* 链路二：分片/倾斜评估——结果不可变，内嵌配置快照，迁移中候选不重判 */}
          <h3 className="panel-title">② 分片与倾斜评估（{selectedRule.name}）</h3>
          <div className="row-actions">
            <button
              className="btn primary"
              type="button"
              disabled={selectedRule.status !== '已启用'}
              title={selectedRule.status === '已启用' ? '' : '只有已启用规则可以评估'}
              onClick={() => report(evaluateRule(selectedRule.id, buildSampleNodes(selectedRule.id)))}
            >
              执行分片评估
            </button>
            <button
              className="btn"
              type="button"
              disabled={selectedRule.status !== '已启用'}
              title={selectedRule.status === '已启用' ? '' : '停用规则不能生成新计划，历史批次仍可查'}
              onClick={() => report(generateMigrationPlan(selectedRule.id))}
            >
              生成再平衡迁移计划
            </button>
          </div>

          {ruleResults.length === 0 && <p className="page-desc">该规则还没有分片评估结果。</p>}
          {ruleResults.map((result) => (
            <details key={result.id} className="result-block" open={result === ruleResults[ruleResults.length - 1]}>
              <summary>
                评估 #{result.id} · {new Date(result.evaluatedAt).toLocaleString()} · 候选 {result.candidates.length} 个
                （携带迁移中 {result.carriedMigrating} 个）
              </summary>
              <p className="page-desc">
                本次快照：算法 {result.config.algorithm} / 分片数量 {result.config.shardCount} /
                阈值 {result.config.skewThreshold} / 触发 {result.config.rebalanceTrigger} /
                策略 {result.config.migrationStrategy}
              </p>
              <table className="data-table inner-table">
                <thead>
                  <tr>
                    <th>节点</th>
                    <th>归属分片</th>
                    <th>目标分片</th>
                    <th>状态</th>
                    <th>原因 / 失败证据</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map((candidate) => (
                    <tr key={candidate.candidateKey}>
                      <td>{candidate.nodeId}</td>
                      <td>{candidate.ownerShardNo}</td>
                      <td>{candidate.targetShardNo}</td>
                      <td>{candidate.status}</td>
                      <td>{candidate.failureReason ? `${candidate.reason}｜失败：${candidate.failureReason}` : candidate.reason}</td>
                    </tr>
                  ))}
                  {result.candidates.length === 0 && (
                    <tr><td className="empty-state" colSpan={5}>本次评估没有倾斜候选</td></tr>
                  )}
                </tbody>
              </table>
            </details>
          ))}

          {/* 链路三：迁移批次——独立实体，停用后仍可查，快照保持生成时原值 */}
          <h3 className="panel-title">③ 再平衡迁移批次（历史可查，按规则编号引用）</h3>
          {ruleBatches.length === 0 && <p className="page-desc">该规则没有迁移批次。</p>}
          {ruleBatches.map((batch) => (
            <details key={batch.id} className="result-block">
              <summary>
                {batch.code} · {batch.status} · 步骤 {batch.steps.length} · 触发 {batch.trigger}
              </summary>
              <p className="page-desc">
                生成时冻结配置：分片数量 {batch.snapshot.shardCount} / 策略 {batch.snapshot.migrationStrategy} /
                阈值 {batch.snapshot.skewThreshold}（规则之后修改不影响本批次）
              </p>
              <table className="data-table inner-table">
                <thead>
                  <tr>
                    <th>步骤</th>
                    <th>节点</th>
                    <th>原分片</th>
                    <th>目标分片</th>
                    <th>状态</th>
                    <th>迁移原因 / 失败证据</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.steps.map((step) => (
                    <tr key={step.stepNo}>
                      <td>{step.stepNo}</td>
                      <td>{step.nodeId}</td>
                      <td>{step.sourceShardNo}</td>
                      <td>{step.targetShardNo}</td>
                      <td>{step.status}</td>
                      <td>{step.failureReason ? `${step.reason}｜失败：${step.failureReason}` : step.reason}</td>
                      <td>
                        {step.status === 'PENDING' && (
                          <span className="row-actions">
                            <button
                              className="link"
                              type="button"
                              onClick={() => report(advanceMigration(batch.id, { ok: true }))}
                            >
                              标记成功
                            </button>
                            <button
                              className="link danger"
                              type="button"
                              onClick={() =>
                                report(advanceMigration(batch.id, { ok: false, failureReason: '模拟目标节点不可用' }))
                              }
                            >
                              模拟失败
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </>
      )}
    </section>
  )

  function transition(rule: SegmentRule, target: SegmentRule['status']): void {
    report(transitionRule(rule.id, target))
  }
}
