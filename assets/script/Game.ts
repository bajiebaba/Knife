import {
    _decorator,
    Component,
    Node,
    Prefab,
    instantiate,
    input,
    Input,
    EventTouch,
    Vec3,
    Label,
    Collider2D,
    PolygonCollider2D,
    Sprite,
    Color,
    Tween,
    tween,
} from 'cc';
const { ccclass, property } = _decorator;

enum RoundState {
    Idle = 'Idle',
    KnifeFlying = 'KnifeFlying',
    RoundWin = 'RoundWin',
    RoundFail = 'RoundFail',
}

@ccclass('Game')
export class Game extends Component {
    @property({ type: Node, tooltip: '上半屏中间的轮盘节点' })
    public wheel: Node | null = null;

    @property({ type: Node, tooltip: '下半屏中间的飞刀出生点节点' })
    public knifeSpawnPoint: Node | null = null;

    @property({ type: Prefab, tooltip: '飞刀预制体（同一个预制体用于待发与已附着飞刀）' })
    public knifePrefab: Prefab | null = null;

    @property({ type: Node, tooltip: '飞刀父节点容器（不填则默认使用当前 Game 节点）' })
    public knifeLayer: Node | null = null;

    @property({ type: Label, tooltip: '进度文本（可选）：例如 3/8' })
    public progressLabel: Label | null = null;

    @property({ type: Node, tooltip: '胜利面板（可选）' })
    public winPanel: Node | null = null;

    @property({ type: Node, tooltip: '失败面板（可选）' })
    public failPanel: Node | null = null;

    @property({ type: Node, tooltip: '胜利面板中的继续游戏按钮（可选）' })
    public winContinueButton: Node | null = null;

    @property({ type: Node, tooltip: '失败面板中的继续游戏按钮（可选）' })
    public failContinueButton: Node | null = null;

    @property({ tooltip: '本局目标飞刀数量' })
    public targetKnifeCount = 8;

    @property({ tooltip: '轮盘旋转速度（角度/秒）' })
    public wheelRotateSpeed = 120;

    @property({ tooltip: '是否启用飞刀分布不均导致的轮盘变速' })
    public wheelImbalanceEnabled = true;

    @property({ tooltip: '轮盘因为飞刀失衡而受重力影响的程度，0 表示不受影响，数值越大变速越明显' })
    public wheelImbalanceInfluence = 2.2;

    @property({ tooltip: '飞刀偏心影响下的轮盘最低速度倍率' })
    public wheelMinSpeedScale = 0.25;

    @property({ tooltip: '飞刀偏心影响下的轮盘最高速度倍率' })
    public wheelMaxSpeedScale = 1.9;

    @property({ tooltip: '轮盘基础转速回正强度，数值越大越快从重力加减速中回到基础轮速' })
    public wheelImbalanceSmooth = 1.6;

    @property({ tooltip: '飞刀上升速度（像素/秒）' })
    public knifeFlySpeed = 1200;

    @property({ tooltip: '轮盘附着半径（像素）' })
    public wheelAttachRadius = 120;

    
    
    @property({ tooltip: '飞刀附着后的角度偏移（度），默认 90 可避免刀尖刀柄反转' })
    public attachedKnifeAngleOffset = 90;
    
    @property({ tooltip: '飞刀命中轮盘时，上下微抖动幅度（像素）' })
    public wheelHitShakeDistance = 10;
    
    @property({ tooltip: '飞刀命中轮盘时，每个半程抖动耗时（秒）' })
    public wheelHitShakeHalfDuration = 0.03;
    
    @property({ tooltip: '飞刀命中轮盘时，抖动往返次数（越大越急促）' })
    public wheelHitShakeRepeatCount = 2;
    
    @property({ tooltip: '撞飞刀失败时，慢动作特写和红色闪烁总时长（秒）' })
    public failFocusDuration = 2;
    
    @property({ tooltip: '撞飞刀失败时，慢动作特写放大倍数' })
    public failFocusScale = 1.12;
    
    @property({ tooltip: '撞飞刀失败时，红色闪烁单次切换间隔（秒）' })
    public failKnifeBlinkInterval = 0.15;
    
    public knifeCollisionRadius = 20;
    private missYMargin = 120;
    
    private roundState: RoundState = RoundState.Idle;
    private currentKnife: Node | null = null;
    private attachedKnives: Node[] = [];
    // 仅用于“失败瞬间保留失误飞刀显示”：
    // 这些节点会在下一局开始时统一销毁，避免跨局残留污染场景。
    private failedDisplayKnives: Node[] = [];
    private hitKnifeCount = 0;
    private wheelCollider: Collider2D | null = null;
    private currentWheelRotateSpeed = 0;

    // 为了避免“点击继续游戏”后同一触摸事件立刻触发发射，这里增加一个极短输入锁。
    private elapsedSeconds = 0;
    private inputLockedUntil = 0;

    // 复用临时向量，避免在 update 中频繁创建对象导致 GC 抖动。
    private readonly tempA = new Vec3();
    private readonly tempB = new Vec3();
    private readonly tempC = new Vec3();
    private readonly wheelBaseLocalPos = new Vec3();
    private readonly wheelShakeUpLocalPos = new Vec3();
    private readonly wheelShakeDownLocalPos = new Vec3();
    private readonly wheelBaseScale = new Vec3();
    private readonly failFocusWheelScale = new Vec3();
    private wheelBasePosCached = false;
    private wheelBaseScaleCached = false;
    private readonly failBlinkRedColor = new Color(255, 40, 40, 255);

    start() {
        this.bindInputEvents();
        this.cacheColliders();
        this.startNewRound();
    }

    update(deltaTime: number) {
        this.elapsedSeconds += deltaTime;

        // 仅在“可进行中”的状态旋转轮盘；结算状态下保持静止，便于玩家看清结果。
        if ((this.roundState === RoundState.Idle || this.roundState === RoundState.KnifeFlying) && this.wheel) {
            this.updateWheelRotation(deltaTime);
        }

        if (this.roundState === RoundState.KnifeFlying) {
            this.updateFlyingKnife(deltaTime);
        }
    }

    onDestroy() {
        input.off(Input.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
        this.winContinueButton?.off(Node.EventType.TOUCH_END, this.onContinueGame, this);
        this.failContinueButton?.off(Node.EventType.TOUCH_END, this.onContinueGame, this);
    }

    private bindInputEvents() {
        input.on(Input.EventType.TOUCH_END, this.onGlobalTouchEnd, this);
        this.winContinueButton?.on(Node.EventType.TOUCH_END, this.onContinueGame, this);
        this.failContinueButton?.on(Node.EventType.TOUCH_END, this.onContinueGame, this);
    }

    private onGlobalTouchEnd(_event: EventTouch) {
        if (this.elapsedSeconds < this.inputLockedUntil) {
            return;
        }
        if (this.roundState !== RoundState.Idle) {
            return;
        }
        this.throwCurrentKnife();
    }

    private onContinueGame() {
        this.startNewRound();
    }

    private clampNumber(value: number, min: number, max: number): number {
        return Math.min(Math.max(value, min), max);
    }

    private clampWheelRotateSpeed(speed: number): number {
        const baseSpeed = this.wheelRotateSpeed;
        const minSpeedScale = Math.min(this.wheelMinSpeedScale, this.wheelMaxSpeedScale);
        const maxSpeedScale = Math.max(this.wheelMinSpeedScale, this.wheelMaxSpeedScale);
        if (Math.abs(baseSpeed) <= Number.EPSILON) {
            return 0;
        }

        const direction = baseSpeed >= 0 ? 1 : -1;
        const speedAbs = Math.abs(speed);
        const baseSpeedAbs = Math.abs(baseSpeed);
        const clampedSpeedAbs = this.clampNumber(speedAbs, baseSpeedAbs * minSpeedScale, baseSpeedAbs * maxSpeedScale);
        return clampedSpeedAbs * direction;
    }

    private getWheelImbalanceGravityAcceleration(): number {
        if (!this.wheelImbalanceEnabled || this.attachedKnives.length === 0) {
            return 0;
        }

        let centerX = 0;
        let centerY = 0;
        let validKnifeCount = 0;
        for (const knife of this.attachedKnives) {
            if (!knife || !knife.isValid) {
                continue;
            }
            // 已插入飞刀都是 wheel 的子节点，所以本地坐标可以直接表示它们在轮盘上的分布方向。
            // 多把飞刀如果分布均匀，向量相加会互相抵消；如果集中在一侧，合向量会明显偏向那一边。
            centerX += knife.position.x;
            centerY += knife.position.y;
            validKnifeCount += 1;
        }
        if (validKnifeCount === 0) {
            return 0;
        }

        centerX /= validKnifeCount;
        centerY /= validKnifeCount;

        const imbalanceLength = Math.sqrt(centerX * centerX + centerY * centerY);
        const normalizedImbalance = this.clampNumber(imbalanceLength / Math.max(1, this.wheelAttachRadius), 0, 1);
        if (normalizedImbalance <= Number.EPSILON) {
            return 0;
        }

        const localImbalanceAngle = Math.atan2(centerY, centerX);
        const worldImbalanceAngle = localImbalanceAngle + this.wheel.angle * (Math.PI / 180);
        const influence = Math.max(0, this.wheelImbalanceInfluence);

        // 重力对偏心轮的扭矩近似：
        // 1) 偏重侧在右侧时，若轮盘按正角速度逆时针旋转，它正处于上升阶段，重力产生反向扭矩 -> 减速；
        // 2) 偏重侧越过顶点后进入下降阶段，重力产生同向扭矩 -> 加速；
        // 3) 到达最低点时扭矩接近 0，但当前角速度已被前半段加速，所以会保留“冲过最低点”的惯性；
        // 4) 过了最低点进入上升阶段后，反向扭矩逐渐增强，速度再自然递减。
        //
        // 公式里的 -cos(angle) 来自 2D 力矩 r x F：
        // r 是偏心质量方向，F 是向下的重力；它能保证“上升减速、下降加速”的相位关系正确。
        const gravityTorque = -Math.cos(worldImbalanceAngle) * normalizedImbalance * influence;

        // wheelRotateSpeed 是角速度（度/秒），这里乘上它的绝对值构造一个角加速度量级（度/秒^2）。
        // 这样基础轮速越快，重力扰动也会相应更有存在感；最终仍会被 min/max speed scale 限制住。
        return gravityTorque * Math.abs(this.wheelRotateSpeed);
    }

    private updateWheelRotation(deltaTime: number) {
        if (!this.wheel) {
            return;
        }

        const gravityAcceleration = this.getWheelImbalanceGravityAcceleration();
        this.currentWheelRotateSpeed += gravityAcceleration * deltaTime;

        const restoreStrength = Math.max(0, this.wheelImbalanceSmooth);
        if (restoreStrength > Number.EPSILON) {
            // 基础轮速可以理解为轮盘电机/玩法驱动，重力只是在其上叠加加减速。
            // 用指数回正而不是直接覆盖速度，可以保留过最低点后的惯性，同时避免长期越滚越快。
            const restoreRatio = 1 - Math.exp(-restoreStrength * deltaTime);
            this.currentWheelRotateSpeed += (this.wheelRotateSpeed - this.currentWheelRotateSpeed) * restoreRatio;
        }

        this.currentWheelRotateSpeed = this.clampWheelRotateSpeed(this.currentWheelRotateSpeed);

        this.wheel.angle += this.currentWheelRotateSpeed * deltaTime;
    }

    private startNewRound() {
        if (!this.wheel || !this.knifeSpawnPoint || !this.knifePrefab) {
            console.warn('[Game] 请先在编辑器中绑定 wheel / knifeSpawnPoint / knifePrefab。');
            return;
        }
        this.cacheColliders();
        this.cacheWheelBaseLocalPosition();
        this.cacheWheelBaseScale();

        // 1) 清理旧局残留的飞刀（包括正在飞行和已附着）。
        if (this.currentKnife && this.currentKnife.isValid) {
            this.currentKnife.destroy();
        }
        this.currentKnife = null;
        for (const knife of this.attachedKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.attachedKnives.length = 0;
        for (const knife of this.failedDisplayKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.failedDisplayKnives.length = 0;

        // 2) 重置计数、状态、界面可见性。
        this.hitKnifeCount = 0;
        this.currentWheelRotateSpeed = this.wheelRotateSpeed;
        this.roundState = RoundState.Idle;
        if (this.wheel) {
            // 开新局时先停止上一局可能未结束的抖动，再复位到“设计稿中的原始位置”。
            // 这样可避免连续命中导致 tween 累积，把轮盘慢慢推离初始位置。
            this.resetWheelToBasePosition(true);
            this.resetWheelToBaseScale(true);
            this.wheel.angle = 0;
        }
        if (this.winPanel) {
            this.winPanel.active = false;
        }
        if (this.failPanel) {
            this.failPanel.active = false;
        }
        this.refreshProgressText();

        // 3) 生成第一把待发飞刀，并短暂锁输入，避免触摸事件串扰导致误发射。
        this.spawnWaitingKnife();
        this.inputLockedUntil = this.elapsedSeconds + 0.1;
    }

    private spawnWaitingKnife() {
        if (!this.knifePrefab || !this.knifeSpawnPoint) {
            return;
        }

        const knife = instantiate(this.knifePrefab);
        const runtimeKnifeLayer = this.knifeLayer ?? this.knifeSpawnPoint.parent ?? this.node;
        knife.setParent(runtimeKnifeLayer);

        // 关键修复：
        // 1) 默认把飞刀放到与 spawnPoint 同一层级空间，避免因父节点不在 UI 渲染树而“逻辑存在但画面看不到”；
        // 2) 若父节点一致，直接用本地坐标可避免不必要的世界坐标换算误差；
        // 3) 若父节点不同，再回退到世界坐标设置，保证位置正确。
        if (runtimeKnifeLayer === this.knifeSpawnPoint.parent) {
            knife.setPosition(this.knifeSpawnPoint.position);
        } else {
            knife.setWorldPosition(this.knifeSpawnPoint.worldPosition);
        }

        // 显式激活并置于同层最前，确保“待发飞刀可见”和“发射过程可观察”。
        knife.active = true;
        knife.setSiblingIndex(knife.parent ? knife.parent.children.length - 1 : 0);
        knife.angle = 0;
        this.currentKnife = knife;
    }

    private throwCurrentKnife() {
        if (!this.currentKnife) {
            return;
        }
        this.roundState = RoundState.KnifeFlying;
    }

    private cacheColliders() {
        this.wheelCollider = this.wheel?.getComponent(Collider2D) ?? null;
        if (!this.wheelCollider) {
            console.warn('[Game] wheel 节点缺少 Collider2D，无法进行“飞刀 vs 轮盘”的碰撞判定。');
        }
    }

    private getKnifeCollider(knife: Node | null): Collider2D | null {
        if (!knife || !knife.isValid) {
            return null;
        }
        return knife.getComponent(Collider2D);
    }

    private getKnifePolygonCollider(knife: Node | null): PolygonCollider2D | null {
        if (!knife || !knife.isValid) {
            return null;
        }
        return knife.getComponent(PolygonCollider2D);
    }

    private isColliderOverlap(a: Collider2D | null, b: Collider2D | null): boolean {
        if (!a || !b || !a.enabledInHierarchy || !b.enabledInHierarchy) {
            return false;
        }

        // 对“非飞刀 vs 飞刀”场景沿用 AABB 快速判定（例如飞刀 vs 轮盘）：
        // 本次需求只要求飞刀之间必须走 PolygonCollider2D 规则，
        // 这里保留旧逻辑作为通用/兜底路径，避免影响其他碰撞链路。
        return a.worldAABB.intersects(b.worldAABB);
    }

    private projectPolygonOnAxis(points: ReadonlyArray<{ x: number; y: number }>, axisX: number, axisY: number): { min: number; max: number } {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const point of points) {
            const projection = point.x * axisX + point.y * axisY;
            if (projection < min) {
                min = projection;
            }
            if (projection > max) {
                max = projection;
            }
        }
        return { min, max };
    }

    private isPolygonSeparatedByAxis(
        pointsA: ReadonlyArray<{ x: number; y: number }>,
        pointsB: ReadonlyArray<{ x: number; y: number }>,
        axisX: number,
        axisY: number,
    ): boolean {
        const projectionA = this.projectPolygonOnAxis(pointsA, axisX, axisY);
        const projectionB = this.projectPolygonOnAxis(pointsB, axisX, axisY);
        return projectionA.max < projectionB.min || projectionB.max < projectionA.min;
    }

    private hasAnySeparatingAxis(
        sourcePolygon: ReadonlyArray<{ x: number; y: number }>,
        otherPolygon: ReadonlyArray<{ x: number; y: number }>,
    ): boolean {
        for (let i = 0; i < sourcePolygon.length; i += 1) {
            const pointA = sourcePolygon[i];
            const pointB = sourcePolygon[(i + 1) % sourcePolygon.length];
            const edgeX = pointB.x - pointA.x;
            const edgeY = pointB.y - pointA.y;

            // 轴取边的法线方向，利用 SAT（Separating Axis Theorem）判断两多边形是否可分离。
            const axisX = -edgeY;
            const axisY = edgeX;
            const axisLengthSquared = axisX * axisX + axisY * axisY;
            if (axisLengthSquared <= Number.EPSILON) {
                continue;
            }

            if (this.isPolygonSeparatedByAxis(sourcePolygon, otherPolygon, axisX, axisY)) {
                return true;
            }
        }
        return false;
    }

    private isPolygonOverlapBySAT(
        pointsA: ReadonlyArray<{ x: number; y: number }>,
        pointsB: ReadonlyArray<{ x: number; y: number }>,
    ): boolean {
        if (pointsA.length < 3 || pointsB.length < 3) {
            return false;
        }
        if (this.hasAnySeparatingAxis(pointsA, pointsB)) {
            return false;
        }
        if (this.hasAnySeparatingAxis(pointsB, pointsA)) {
            return false;
        }
        return true;
    }

    private isKnifePolygonColliderOverlap(a: PolygonCollider2D | null, b: PolygonCollider2D | null): boolean {
        if (!a || !b || !a.enabledInHierarchy || !b.enabledInHierarchy) {
            return false;
        }

        // 关键逻辑：
        // 直接使用 PolygonCollider2D 的 worldPoints（即多边形在世界坐标系下的顶点）
        // 进行 SAT 相交检测。这样“飞刀 vs 飞刀”的碰撞结果由多边形轮廓决定，
        // 与编辑器里 PolygonCollider2D 调整出的形状保持一致。
        return this.isPolygonOverlapBySAT(a.worldPoints, b.worldPoints);
    }

    private getHitAttachedKnifeByCollider(): Node | null {
        // 明确要求：飞刀之间的判定应按 PolygonCollider2D 规则进行。
        // 因此这里对“当前飞刀”先做一次显式校验，便于在资源配置错误时快速定位问题。
        const flyingKnifePolygonCollider = this.getKnifePolygonCollider(this.currentKnife);
        if (!flyingKnifePolygonCollider) {
            console.warn('[Game] 当前飞刀缺少 PolygonCollider2D，飞刀间碰撞无法按多边形规则判定。');
            return null;
        }

        // 使用对象自身 Collider2D 做判定：只要“当前飞刀”与任意已附着飞刀发生接触，即判定失败。
        // 这里明确走 isKnifePolygonColliderOverlap（SAT + worldPoints），
        // 确保飞刀之间严格按 PolygonCollider2D 的形状规则判定。
        for (const attachedKnife of this.attachedKnives) {
            if (!attachedKnife || !attachedKnife.isValid) {
                continue;
            }
            const attachedKnifePolygonCollider = this.getKnifePolygonCollider(attachedKnife);
            if (!attachedKnifePolygonCollider) {
                // 已附着飞刀如果没挂 PolygonCollider2D，会破坏“飞刀 vs 飞刀”统一规则，给出明确告警。
                console.warn('[Game] 已附着飞刀缺少 PolygonCollider2D，飞刀间碰撞无法按多边形规则判定。');
                continue;
            }
            if (this.isKnifePolygonColliderOverlap(flyingKnifePolygonCollider, attachedKnifePolygonCollider)) {
                return attachedKnife;
            }
        }
        return null;
    }

    private checkKnifeHitWheelByCollider(): boolean {
        const flyingKnifeCollider = this.getKnifeCollider(this.currentKnife);
        if (!flyingKnifeCollider || !this.wheelCollider) {
            return false;
        }
        // 使用对象自身 Collider2D 做判定：飞刀与轮盘发生碰撞盒交叠，即视作命中轮盘。
        return this.isColliderOverlap(flyingKnifeCollider, this.wheelCollider);
    }

    private updateFlyingKnife(deltaTime: number) {
        if (!this.currentKnife || !this.currentKnife.isValid || !this.wheel) {
            this.failRound();
            return;
        }

        // 记录移动前坐标，用于做“跨帧穿越检测”。
        this.currentKnife.getWorldPosition(this.tempA);
        this.tempB.set(this.tempA);

        // 飞刀每帧沿世界 Y 轴正方向直线移动，符合“掷出后直线向上”的规则。
        this.tempB.y += this.knifeFlySpeed * deltaTime;
        this.currentKnife.setWorldPosition(this.tempB);

        // 按规则优先检查“飞刀撞已附着飞刀”的失败条件。
        const hitAttachedKnife = this.getHitAttachedKnifeByCollider();
        if (hitAttachedKnife) {
            // 按需求：新飞刀撞到老飞刀时，新飞刀应保留在碰撞瞬间的位置，不做销毁。
            // 这里传 false，进入失败结算但不 destroy 当前飞刀，让画面反馈更直观。
            this.failRound(false, hitAttachedKnife);
            return;
        }

        // 再检查“飞刀撞轮盘”的成功条件，命中后立刻附着并进入下一把飞刀流程。
        if (this.checkKnifeHitWheelByCollider()) {
            this.attachCurrentKnifeToWheelByCurrentWorldPos();
            return;
        }

        // 兜底：若碰撞组件配置异常或极端速度导致漏检，飞刀越过轮盘后仍会失败，避免游戏卡在飞行状态。
        if (this.isKnifeMissedWheel(this.tempB)) {
            this.failRound();
        }
    }

    private isKnifeMissedWheel(currWorldPos: Vec3): boolean {
        if (!this.wheel) {
            return false;
        }

        this.wheel.getWorldPosition(this.tempC);
        const overTopY = this.tempC.y + this.wheelAttachRadius + this.missYMargin;
        if (currWorldPos.y > overTopY) {
            return true;
        }

        // 如果 X 已明显偏离轮盘且飞刀已经飞到轮盘中心以上，也视为本次不可能命中，提前失败可避免拖帧和卡状态。
        const impossibleHitX = Math.abs(currWorldPos.x - this.tempC.x) > this.wheelAttachRadius + this.knifeCollisionRadius;
        return impossibleHitX && currWorldPos.y >= this.tempC.y;
    }

    private cacheWheelBaseLocalPosition() {
        if (!this.wheel || this.wheelBasePosCached) {
            return;
        }
        this.wheel.getPosition(this.wheelBaseLocalPos);
        this.wheelBasePosCached = true;
    }

    private cacheWheelBaseScale() {
        if (!this.wheel || this.wheelBaseScaleCached) {
            return;
        }
        this.wheel.getScale(this.wheelBaseScale);
        this.wheelBaseScaleCached = true;
    }

    private resetWheelToBasePosition(stopShakeTween = true) {
        if (!this.wheel) {
            return;
        }
        this.cacheWheelBaseLocalPosition();
        if (!this.wheelBasePosCached) {
            return;
        }

        // 统一“轮盘归位”入口，避免不同调用方重复写停止 tween / 复位坐标逻辑。
        if (stopShakeTween) {
            Tween.stopAllByTarget(this.wheel);
        }
        // 强制回到缓存的初始本地坐标，确保抖动结束后位置绝对一致。
        this.wheel.setPosition(this.wheelBaseLocalPos);
    }

    private resetWheelToBaseScale(stopScaleTween = true) {
        if (!this.wheel) {
            return;
        }
        this.cacheWheelBaseScale();
        if (!this.wheelBaseScaleCached) {
            return;
        }

        // 慢动作特写会临时放大轮盘；这里统一负责停掉缩放 tween 并恢复初始缩放。
        if (stopScaleTween) {
            Tween.stopAllByTarget(this.wheel);
        }
        this.wheel.setScale(this.wheelBaseScale);
    }

    private playWheelHitShake(onComplete?: () => void) {
        if (!this.wheel) {
            onComplete?.();
            return;
        }
        this.cacheWheelBaseLocalPosition();
        if (!this.wheelBasePosCached) {
            onComplete?.();
            return;
        }

        const shakeDistance = Math.max(0, this.wheelHitShakeDistance);
        const halfDuration = Math.max(0.01, this.wheelHitShakeHalfDuration);
        const repeatCount = Math.max(1, Math.floor(this.wheelHitShakeRepeatCount));
        if (shakeDistance <= Number.EPSILON) {
            this.resetWheelToBasePosition(true);
            onComplete?.();
            return;
        }

        // 命中触发是高频事件（玩家可能快速连击）：
        // 每次命中先“清掉上一次尚未完成的抖动”并复位基准点，
        // 再从同一起点播放新的急促抖动，避免多个 tween 并发导致位移漂移和视觉拉扯。
        this.resetWheelToBasePosition(true);

        this.wheelShakeUpLocalPos.set(
            this.wheelBaseLocalPos.x,
            this.wheelBaseLocalPos.y + shakeDistance,
            this.wheelBaseLocalPos.z,
        );
        this.wheelShakeDownLocalPos.set(
            this.wheelBaseLocalPos.x,
            this.wheelBaseLocalPos.y - shakeDistance,
            this.wheelBaseLocalPos.z,
        );

        let shakeTween = tween(this.wheel);
        for (let i = 0; i < repeatCount; i += 1) {
            // 第一段先往上提，第二段压到下方，形成“急促受击感”。
            shakeTween = shakeTween
                .to(halfDuration, { position: this.wheelShakeUpLocalPos })
                .to(halfDuration, { position: this.wheelShakeDownLocalPos });
        }
        // 尾段先插值回基准点，再回调里“强制归位”一次：
        // 即使存在浮点误差或外部打断，也能保证最终位置是初始位置。
        shakeTween
            .to(halfDuration, { position: this.wheelBaseLocalPos })
            .call(() => {
                this.resetWheelToBasePosition(false);
                onComplete?.();
            })
            .start();
    }

    private showFailPanel() {
        if (this.failPanel) {
            this.failPanel.active = true;
        }
    }

    private setKnifeSpritesColor(knife: Node, color: Color) {
        const sprites = knife.getComponentsInChildren(Sprite);
        for (const sprite of sprites) {
            sprite.color = color;
        }
    }

    private collectKnifeSpriteColors(knife: Node): Array<{ sprite: Sprite; color: Color }> {
        const colors: Array<{ sprite: Sprite; color: Color }> = [];
        const sprites = knife.getComponentsInChildren(Sprite);
        for (const sprite of sprites) {
            const color = sprite.color;
            colors.push({
                sprite,
                color: new Color(color.r, color.g, color.b, color.a),
            });
        }
        return colors;
    }

    private restoreKnifeSpriteColors(colors: Array<{ sprite: Sprite; color: Color }>) {
        for (const item of colors) {
            if (item.sprite && item.sprite.isValid) {
                item.sprite.color = item.color;
            }
        }
    }

    private playFailFocusEffect(collidedKnives: Node[]) {
        const validCollidedKnives = collidedKnives.filter((knife) => knife && knife.isValid);
        if (validCollidedKnives.length === 0) {
            this.showFailPanel();
            return;
        }

        this.cacheWheelBaseScale();
        const duration = Math.max(0.1, this.failFocusDuration);
        const blinkInterval = Math.max(0.05, this.failKnifeBlinkInterval);
        const focusScale = Math.max(1, this.failFocusScale);
        const knifeBaseScales = validCollidedKnives.map((knife) => {
            const scale = new Vec3();
            knife.getScale(scale);
            return { knife, scale };
        });
        const originalSpriteColors: Array<{ sprite: Sprite; color: Color }> = [];
        for (const knife of validCollidedKnives) {
            originalSpriteColors.push(...this.collectKnifeSpriteColors(knife));
        }

        // “慢动作特写”用轻微放大来表现：轮盘和两把碰撞飞刀同步放大，形成镜头靠近的视觉反馈。
        // 这里仍保持逻辑状态为 RoundFail，游戏输入和飞刀运动都已经停住，玩家能清楚看到失败原因。
        if (this.wheel && this.wheelBaseScaleCached) {
            this.failFocusWheelScale.set(
                this.wheelBaseScale.x * focusScale,
                this.wheelBaseScale.y * focusScale,
                this.wheelBaseScale.z,
            );
            tween(this.wheel).to(0.25, { scale: this.failFocusWheelScale }).start();
        }
        for (const item of knifeBaseScales) {
            const focusKnifeScale = new Vec3();
            focusKnifeScale.set(
                item.scale.x * focusScale,
                item.scale.y * focusScale,
                item.scale.z,
            );
            tween(item.knife).to(0.25, { scale: focusKnifeScale }).start();
        }

        const blinkTimes = Math.max(1, Math.floor(duration / blinkInterval));
        let blinkTween = tween(this.node);
        for (let i = 0; i < blinkTimes; i += 1) {
            blinkTween = blinkTween
                .call(() => {
                    if (i % 2 === 0) {
                        for (const knife of validCollidedKnives) {
                            if (knife.isValid) {
                                this.setKnifeSpritesColor(knife, this.failBlinkRedColor);
                            }
                        }
                    } else {
                        this.restoreKnifeSpriteColors(originalSpriteColors);
                    }
                })
                .delay(blinkInterval);
        }

        blinkTween
            .call(() => {
                for (const item of knifeBaseScales) {
                    if (item.knife.isValid) {
                        item.knife.setScale(item.scale);
                    }
                }
                if (this.wheel && this.wheelBaseScaleCached) {
                    this.wheel.setScale(this.wheelBaseScale);
                }
                this.restoreKnifeSpriteColors(originalSpriteColors);
                for (const knife of validCollidedKnives) {
                    if (knife.isValid) {
                        // 闪烁结束后把两把碰撞飞刀都定格为红色，失败面板弹出时仍能一眼看到碰撞双方。
                        this.setKnifeSpritesColor(knife, this.failBlinkRedColor);
                    }
                }
                if (this.roundState === RoundState.RoundFail) {
                    this.showFailPanel();
                }
            })
            .start();
    }

    private attachCurrentKnifeToWheelByCurrentWorldPos() {
        if (!this.currentKnife || !this.wheel) {
            return;
        }

        // 新飞刀命中时，如果上一把飞刀的受击抖动尚未结束，轮盘可能正处于上下偏移状态。
        // 先归位再计算 inverseTransformPoint，确保“飞刀挂到轮盘后的本地坐标”始终基于初始轮盘位置，
        // 否则随后抖动归位会把刚挂上的飞刀一起带偏，出现命中点视觉漂移。
        this.resetWheelToBasePosition(true);

        // 关键修复：
        // 碰撞发生时直接记录当前飞刀“世界坐标命中点”，再转为轮盘本地坐标挂载，
        // 可以保证飞刀成为轮盘子节点后持续保持相对位置，不会出现漂移。
        this.currentKnife.getWorldPosition(this.tempA);
        this.wheel.inverseTransformPoint(this.tempC, this.tempA);
        this.currentKnife.setParent(this.wheel, false);
        this.currentKnife.setPosition(this.tempC);

        // 修复“命中瞬间刀尖刀柄反转”：
        // 以附着点相对轮盘中心的角度为基准，并使用可配置偏移值。
        // 默认 +90 度对应“刀尖朝向轮盘中心”的常见美术朝向；若资源朝向不同可在 Inspector 调整。
        const localRad = Math.atan2(this.tempC.y, this.tempC.x);
        this.currentKnife.angle = localRad * (180 / Math.PI) + this.attachedKnifeAngleOffset;

        this.attachedKnives.push(this.currentKnife);
        this.currentKnife = null;

        this.hitKnifeCount += 1;
        this.refreshProgressText();

        if (this.hitKnifeCount >= this.targetKnifeCount) {
            // 最后一刀也要完整播放命中反馈：
            // 先把状态切到胜利，阻止 update 继续驱动飞刀；再等待抖动结束后弹出胜利面板。
            this.winRound(true);
            this.playWheelHitShake(() => {
                if (this.roundState === RoundState.RoundWin) {
                    this.showWinPanel();
                }
            });
            return;
        }

        // 飞刀命中轮盘时增加“急促上下微抖动”反馈，强化打击感。
        // 使用轮盘本体抖动，已附着飞刀作为其子节点会同步抖动，视觉上更自然。
        this.playWheelHitShake();

        // 命中成功后立即生成新待发飞刀，回到等待点击状态。
        this.spawnWaitingKnife();
        this.roundState = RoundState.Idle;
    }

    private showWinPanel() {
        if (this.winPanel) {
            this.winPanel.active = true;
        }
    }

    private winRound(waitForCurrentShake = false) {
        this.roundState = RoundState.RoundWin;
        if (!waitForCurrentShake) {
            // 非命中抖动触发的胜利结算，仍然先停抖动并归位，再展示 UI。
            this.resetWheelToBasePosition(true);
            this.showWinPanel();
        }
        this.inputLockedUntil = this.elapsedSeconds + 0.1;
    }

    private failRound(destroyCurrentKnife = true, hitAttachedKnife: Node | null = null) {
        this.roundState = RoundState.RoundFail;
        // 失败结算同样先归位，避免在抖动中定格导致轮盘停在中间偏移位置。
        this.resetWheelToBasePosition(true);
        this.resetWheelToBaseScale(true);

        const failedFlyingKnife = !destroyCurrentKnife && this.currentKnife && this.currentKnife.isValid ? this.currentKnife : null;

        // 失败分两类：
        // 1) 撞老飞刀失败：保留新飞刀（destroyCurrentKnife = false）；
        // 2) 其它失败（越界/异常）：清理新飞刀（destroyCurrentKnife = true）。
        if (destroyCurrentKnife && this.currentKnife && this.currentKnife.isValid) {
            this.currentKnife.destroy();
        }

        // 当需要“失败瞬间保留失误飞刀”时，把它登记到 failedDisplayKnives，
        // 这样玩家能看到失误反馈，同时又能保证下一局开始时被统一清理。
        if (!destroyCurrentKnife && this.currentKnife && this.currentKnife.isValid) {
            this.failedDisplayKnives.push(this.currentKnife);

            // 失败画面阶段不再需要该飞刀参与碰撞，先禁用其 Collider2D，
            // 避免后续界面动画或误触发导致额外碰撞计算。
            const knifeCollider = this.getKnifeCollider(this.currentKnife);
            if (knifeCollider) {
                knifeCollider.enabled = false;
            }
        }

        // 无论是否销毁，都把 currentKnife 引用置空，确保状态机进入失败后不会继续驱动该飞刀。
        this.currentKnife = null;

        if (failedFlyingKnife) {
            // 撞飞刀失败时不立刻弹失败面板：
            // 先播放慢动作特写和红色闪烁，让玩家明确看到是哪两把飞刀发生碰撞。
            this.inputLockedUntil = this.elapsedSeconds + this.failFocusDuration + 0.1;
            this.playFailFocusEffect([failedFlyingKnife, hitAttachedKnife].filter((knife): knife is Node => !!knife));
            return;
        }

        this.showFailPanel();
        this.inputLockedUntil = this.elapsedSeconds + 0.1;
    }

    private refreshProgressText() {
        if (!this.progressLabel) {
            return;
        }
        this.progressLabel.string = `${this.hitKnifeCount}/${this.targetKnifeCount}`;
    }
}
