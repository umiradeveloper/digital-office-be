import { ApprovalsService } from './approvals.service';

/** Uji routing approval (BR-05, AC 10.3): threshold & kondisi branch per level. */
describe('ApprovalsService routing', () => {
  const svc = new ApprovalsService({} as any, {} as any, {} as any);
  const req = (priority: any, amount: number | null = null, departmentId: bigint | null = 2n) =>
    ({ id: 1n, typeId: 10n, departmentId, priority, amount, requesterUserId: 99n }) as any;
  const lvl = (levelOrder: number, conditionJson: any = null) =>
    ({ id: BigInt(levelOrder), flowId: 1n, levelOrder, name: `L${levelOrder}`, approverType: 'role', approverRoleId: 5n, approverUserId: null, sameDeptOnly: true, delegateOn: true, slaHours: 24, conditionJson }) as any;

  it('level bersyarat prioritas tinggi hanya dilalui jika prioritas ≥ high', () => {
    const levels = [lvl(1), lvl(2), lvl(3, { min_priority: 'high' })];
    expect(svc.buildPlan(levels, req('med')).map((p) => p.levelOrder)).toEqual([1, 2]);
    expect(svc.buildPlan(levels, req('high')).map((p) => p.levelOrder)).toEqual([1, 2, 3]);
    expect(svc.buildPlan(levels, req('crit')).map((p) => p.levelOrder)).toEqual([1, 2, 3]);
  });

  it('level urut berdasarkan level_order (BR-02)', () => {
    expect(svc.buildPlan([lvl(3), lvl(1), lvl(2)], req('low')).map((p) => p.levelOrder)).toEqual([1, 2, 3]);
  });

  it('memilih alur paling spesifik yang cocok', async () => {
    const flows = [
      { id: 1n, name: 'Standar', departmentId: null, triggerTypeId: 10n, thresholdRuleJson: null, levels: [lvl(1)] },
      { id: 2n, name: 'High', departmentId: null, triggerTypeId: 10n, thresholdRuleJson: { min_priority: 'high' }, levels: [lvl(1)] },
      { id: 3n, name: 'Nilai besar', departmentId: null, triggerTypeId: 10n, thresholdRuleJson: { threshold_value: 50_000_000 }, levels: [lvl(1)] },
      { id: 4n, name: 'Khusus unit 2', departmentId: 2n, triggerTypeId: 10n, thresholdRuleJson: { min_priority: 'crit' }, levels: [lvl(1)] },
    ];
    const db = { approvalFlow: { findMany: async () => flows } } as any;
    expect((await svc.matchFlow(req('med'), db))?.name).toBe('Standar');
    expect((await svc.matchFlow(req('high'), db))?.name).toBe('High');
    expect((await svc.matchFlow(req('med', 75_000_000), db))?.name).toBe('Nilai besar');
    expect((await svc.matchFlow(req('crit'), db))?.name).toBe('Khusus unit 2');
  });
});
