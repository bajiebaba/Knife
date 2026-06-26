import {
    _decorator,
    CircleCollider2D,
    Color,
    Collider2D,
    Component,
    Mat4,
    Node,
    PolygonCollider2D,
    Sprite,
    Tween,
    tween,
    UITransform,
    view,
    Vec2,
    Vec3,
} from 'cc';
const { ccclass, property } = _decorator;

/** 中间层默认节点名：负责自转与命中上下抖动 */
const WHEEL_MIDDLE_LAYER_NAME = 'middle';
/** 特写层默认节点名：失败慢镜头缩放 */
const WHEEL_FOCUS_LAYER_NAME = 'focus';
/** 内层默认节点名：轮盘视觉与碰撞体 */
const WHEEL_BODY_LAYER_NAME = 'body';

@ccclass('WheelController')
export class WheelController extends Component {
    @property({ type: Node, tooltip: '中间层节点：负责自转与命中抖动；未绑定时会自动创建' })
    public middleLayer: Node | null = null;

    @property({ type: Node, tooltip: '特写层节点：失败慢镜头缩放；未绑定时会自动创建' })
    public focusLayer: Node | null = null;

    @property({ type: Node, tooltip: '内层节点：轮盘视觉与碰撞体；未绑定时自动查找 body 子节点' })
    public bodyLayer: Node | null = null;
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

    @property({ tooltip: '轮盘附着半径（像素）' })
    public wheelAttachRadius = 120;

    @property({ tooltip: '飞刀附着后的角度偏移（度）；锚点在剑尖时默认 90，使刀柄沿半径向外' })
    public attachedKnifeAngleOffset = 90;

    @property({ tooltip: '飞刀命中后轮盘半径方向“立正”旋转耗时（秒）' })
    public attachedKnifeAlignDuration = 0.2;

    @property({ tooltip: '飞刀命中轮盘时，上下微抖动幅度（像素）' })
    public wheelHitShakeDistance = 10;

    @property({ tooltip: '飞刀命中轮盘时，每个半程抖动耗时（秒）' })
    public wheelHitShakeHalfDuration = 0.03;

    @property({ tooltip: '飞刀命中轮盘时，抖动往返次数（越大越急促）' })
    public wheelHitShakeRepeatCount = 2;

    @property({ tooltip: '轮盘是否在屏幕左右方向来回移动' })
    public horizontalMoveEnabled = true;

    @property({ tooltip: '轮盘左右往返移动的半幅距离（像素）' })
    public horizontalMoveDistance = 220;

    @property({ tooltip: '轮盘左右往返移动一整周期耗时（秒）' })
    public horizontalMovePeriod = 3.5;

    @property({ tooltip: '失败特写：镜头推近并居中事故焦点的耗时（秒）' })
    public failFocusMoveDuration = 0.35;

    private readonly attachedKnives: Node[] = [];
    private wheelCollider: Collider2D | null = null;
    private currentWheelRotateSpeed = 0;

    /** 外层：挂载 WheelController 的根节点，负责左右移动 */
    private outerNode: Node | null = null;
    /** 特写层：失败慢镜头缩放，位于 outer 与 middle 之间 */
    private focusNode: Node | null = null;
    /** 中间层：负责自转与命中抖动 */
    private middleNode: Node | null = null;
    /** 内层：轮盘视觉与碰撞体，飞刀挂载在中间层以跟随自转 */
    private bodyNode: Node | null = null;

    private readonly tempA = new Vec3();
    private readonly tempB = new Vec3();
    private readonly tempC = new Vec3();
    /** 碰撞交集中心累加采样，避免每帧分配 */
    private readonly overlapSampleAccumulator = { sumX: 0, sumY: 0, count: 0 };
    /** 刀身采样点本地偏移 / 旋转后偏移，供失衡调速复用 */
    private readonly tempKnifeLocalOffset = new Vec3();
    private readonly tempKnifeRotatedOffset = new Vec3();
    private readonly tempMat4 = new Mat4();
    private readonly wheelBaseLocalPos = new Vec3();
    private readonly wheelShakeUpLocalPos = new Vec3();
    private readonly wheelShakeDownLocalPos = new Vec3();
    private readonly wheelBaseScale = new Vec3();
    private wheelBasePosCached = false;
    private wheelBaseScaleCached = false;
    private horizontalMoveElapsed = 0;
    private hitShakeOffsetY = 0;
    /** 命中抖动 tween 的独立目标，避免 stopAllByTarget(outer/middle) 误伤左右移动 */
    private readonly hitShakeTweenTarget = { offsetY: 0 };
    /** 飞刀立正 tween 目标（按实例复用，避免与 node.angle 直接 tween 产生大角绕圈） */
    private readonly knifeAlignTweenTarget = { angle: 0 };
    /** 失败特写闪烁 timeline 的独立 tween 目标，避免与 focus 缩放 tween 互相打断 */
    private readonly failFocusBlinkTweenTarget = { tick: 0 };
    private readonly failFocusTargetScale = new Vec3();
    /** 失败特写镜头 tween：同步驱动 outer 位移 + focus 缩放 */
    private readonly failFocusCameraTweenTarget = { progress: 0 };
    private readonly failFocusCameraState = {
        outerStartWorldX: 0,
        outerStartWorldY: 0,
        outerStartWorldZ: 0,
        outerEndWorldX: 0,
        outerEndWorldY: 0,
        focalVectorX: 0,
        focalVectorY: 0,
        targetFocusScale: 1,
    };
    private wheelLayersReady = false;
    private readonly failBlinkRedColor = new Color(255, 40, 40, 255);

    public initialize() {
        this.ensureWheelHierarchy();
        // 层级或 Collider 挂载点变更后必须重新查找，避免沿用过期引用。
        this.wheelCollider = null;
        this.cacheCollider();
        this.cacheBaseLocalPosition();
        this.cacheBaseScale();
        this.currentWheelRotateSpeed = this.wheelRotateSpeed;
    }

    public resetForNewRound() {
        this.initialize();
        this.stopTweensAndResetTransform();
        if (this.middleNode) {
            this.middleNode.angle = 0;
        }
        this.currentWheelRotateSpeed = this.wheelRotateSpeed;
        this.horizontalMoveElapsed = 0;
        this.hitShakeOffsetY = 0;

        for (const knife of this.attachedKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.attachedKnives.length = 0;
    }

    public updateWheelRotation(deltaTime: number) {
        this.updateHorizontalMovement(deltaTime);

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
        if (this.middleNode) {
            this.middleNode.angle += this.currentWheelRotateSpeed * deltaTime;
        }
    }

    private updateHorizontalMovement(deltaTime: number) {
        this.cacheBaseLocalPosition();
        if (!this.wheelBasePosCached) {
            return;
        }

        if (this.horizontalMoveEnabled) {
            this.horizontalMoveElapsed += deltaTime;
        }
        this.applyWheelLocalPosition();
    }

    public checkKnifeHitWheel(knife: Node | null): boolean {
        const flyingKnifeCollider = this.getKnifeCollider(knife);
        const wheelCollider = this.getCollider();
        if (!flyingKnifeCollider || !wheelCollider) {
            return false;
        }
        return this.isColliderOverlap(flyingKnifeCollider, wheelCollider);
    }

    public getHitAttachedKnifeByCollider(flyingKnife: Node | null): Node | null {
        const flyingKnifePolygonCollider = this.getKnifePolygonCollider(flyingKnife);
        if (!flyingKnifePolygonCollider) {
            console.warn('[WheelController] 当前飞刀缺少 PolygonCollider2D，飞刀间碰撞无法按多边形规则判定。');
            return null;
        }

        // 使用 PolygonCollider2D 的世界顶点做飞刀间判定，确保失败条件跟飞刀轮廓一致。
        for (const attachedKnife of this.attachedKnives) {
            if (!attachedKnife || !attachedKnife.isValid) {
                continue;
            }
            const attachedKnifePolygonCollider = this.getKnifePolygonCollider(attachedKnife);
            if (!attachedKnifePolygonCollider) {
                console.warn('[WheelController] 已附着飞刀缺少 PolygonCollider2D，飞刀间碰撞无法按多边形规则判定。');
                continue;
            }
            if (this.isKnifePolygonColliderOverlap(flyingKnifePolygonCollider, attachedKnifePolygonCollider)) {
                return attachedKnife;
            }
        }
        return null;
    }

    public attachKnifeAtCurrentWorldPosition(knife: Node) {
        // 挂载前只复位中间层抖动，不能重置外层左右移动相位。
        this.resetWheelShake(true);
        this.ensureWheelHierarchy();
        const attachParent = this.middleNode ?? this.node;

        Tween.stopAllByTarget(knife);
        Tween.stopAllByTarget(this.knifeAlignTweenTarget);

        // 1) 碰撞瞬间记录世界朝向（须在改父节点/位置之前采样）。
        const hitWorldAngleZ = this.getNodeWorldAngleZ(knife);
        knife.getWorldPosition(this.tempB);

        // 2) 计算剑尖在轮盘圆周上的立足点（仍在原父节点下采样碰撞体世界坐标）。
        const hasAttachPoint = this.cacheKnifeWheelAttachPointWorld(knife, this.tempA);
        const attachWorldPos = hasAttachPoint ? this.tempA : this.tempB;

        // 3) 显式写入 middle 本地坐标与本地 angle，避免 setWorldPosition/setWorldRotation 在旋转父节点下改写朝向。
        knife.setParent(attachParent, false);
        attachParent.inverseTransformPoint(this.tempC, attachWorldPos);
        knife.setPosition(this.tempC);
        this.applyNodeLocalAngleFromWorldAngleZ(knife, hitWorldAngleZ);

        const targetAngle = this.getAttachedKnifeTargetAngle(knife.position);
        this.playKnifeAlignAnimation(knife, targetAngle);
        this.attachedKnives.push(knife);
    }

    /** 从世界矩阵提取 2D 节点 Z 轴朝向（比 Quat 欧拉角更稳定） */
    private getNodeWorldAngleZ(node: Node): number {
        node.getWorldMatrix(this.tempMat4);
        return Math.atan2(this.tempMat4.m01, this.tempMat4.m00) * (180 / Math.PI);
    }

    /** 在已确定父节点与本地位置后，按目标世界朝向反算本地 angle */
    private applyNodeLocalAngleFromWorldAngleZ(node: Node, worldAngleZ: number) {
        const parent = node.parent;
        if (!parent) {
            node.angle = worldAngleZ;
            return;
        }
        node.angle = worldAngleZ - this.getNodeWorldAngleZ(parent);
    }

    /**
     * 计算飞刀命中后的立足点（世界坐标）：
     * 1) 先求飞刀多边形与轮盘圆的碰撞交集中心；
     * 2) 再取轮盘圆周上距该交集中心最近的点（剑尖锚点落在此处）。
     */
    private cacheKnifeWheelAttachPointWorld(knife: Node, out: Vec3): boolean {
        const knifePolygon = this.getKnifePolygonCollider(knife);
        const wheelCollider = this.getCollider();
        if (!knifePolygon || !wheelCollider) {
            knife.getWorldPosition(out);
            return false;
        }

        if (wheelCollider instanceof CircleCollider2D) {
            let hasOverlapCenter = this.cacheCirclePolygonOverlapCenterWorld(knifePolygon, wheelCollider, this.tempB);
            if (!hasOverlapCenter) {
                hasOverlapCenter = this.cacheColliderAabbOverlapCenterWorld(knifePolygon, wheelCollider, this.tempB);
            }
            if (hasOverlapCenter) {
                this.cacheClosestPointOnCirclePerimeterWorld(
                    wheelCollider,
                    this.tempB.x,
                    this.tempB.y,
                    knife,
                    out,
                );
                return true;
            }
        }

        return this.cacheKnifeWheelOverlapCenterWorld(knife, out);
    }

    /**
     * 计算飞刀 PolygonCollider2D 与轮盘 Collider2D 交集区域的中心（世界坐标）。
     * 轮盘为圆形时采样：多边形在圆内的顶点、圆心在多边形内、边与圆的交点。
     */
    private cacheKnifeWheelOverlapCenterWorld(knife: Node, out: Vec3): boolean {
        const knifePolygon = this.getKnifePolygonCollider(knife);
        const wheelCollider = this.getCollider();
        if (!knifePolygon || !wheelCollider) {
            knife.getWorldPosition(out);
            return false;
        }

        if (wheelCollider instanceof CircleCollider2D) {
            if (this.cacheCirclePolygonOverlapCenterWorld(knifePolygon, wheelCollider, out)) {
                return true;
            }
        }

        return this.cacheColliderAabbOverlapCenterWorld(knifePolygon, wheelCollider, out);
    }

    private cacheCirclePolygonOverlapCenterWorld(
        knifePolygon: PolygonCollider2D,
        wheelCircle: CircleCollider2D,
        out: Vec3,
    ): boolean {
        const worldPoints = knifePolygon.worldPoints;
        if (worldPoints.length < 3) {
            return false;
        }

        this.cacheCircleColliderWorldShape(wheelCircle, this.tempB, this.tempC);
        const circleCenterX = this.tempB.x;
        const circleCenterY = this.tempB.y;
        const circleRadius = this.tempC.x;

        const acc = this.overlapSampleAccumulator;
        acc.sumX = 0;
        acc.sumY = 0;
        acc.count = 0;

        for (const point of worldPoints) {
            if (this.isPointInCircle(point.x, point.y, circleCenterX, circleCenterY, circleRadius)) {
                this.accumulateOverlapSample(acc, point.x, point.y);
            }
        }

        if (this.isPointInPolygon(circleCenterX, circleCenterY, worldPoints)) {
            this.accumulateOverlapSample(acc, circleCenterX, circleCenterY);
        }

        for (let i = 0; i < worldPoints.length; i += 1) {
            const pointA = worldPoints[i];
            const pointB = worldPoints[(i + 1) % worldPoints.length];
            this.accumulateSegmentCircleIntersections(
                acc,
                pointA.x,
                pointA.y,
                pointB.x,
                pointB.y,
                circleCenterX,
                circleCenterY,
                circleRadius,
            );
        }

        if (acc.count > 0) {
            out.set(acc.sumX / acc.count, acc.sumY / acc.count, this.tempB.z);
            return true;
        }

        return false;
    }

    private cacheColliderAabbOverlapCenterWorld(
        knifeCollider: Collider2D,
        wheelCollider: Collider2D,
        out: Vec3,
    ): boolean {
        const knifeAabb = knifeCollider.worldAABB;
        const wheelAabb = wheelCollider.worldAABB;
        const overlapMinX = Math.max(knifeAabb.x, wheelAabb.x);
        const overlapMinY = Math.max(knifeAabb.y, wheelAabb.y);
        const overlapMaxX = Math.min(knifeAabb.x + knifeAabb.width, wheelAabb.x + wheelAabb.width);
        const overlapMaxY = Math.min(knifeAabb.y + knifeAabb.height, wheelAabb.y + wheelAabb.height);
        if (overlapMaxX < overlapMinX || overlapMaxY < overlapMinY) {
            knifeCollider.node.getWorldPosition(out);
            return false;
        }

        out.set(
            (overlapMinX + overlapMaxX) * 0.5,
            (overlapMinY + overlapMaxY) * 0.5,
            knifeCollider.node.worldPosition.z,
        );
        return true;
    }

    /** centerOut=圆心，radiusOut.x=世界半径 */
    private cacheCircleColliderWorldShape(circle: CircleCollider2D, centerOut: Vec3, radiusOut: Vec3) {
        const aabb = circle.worldAABB;
        centerOut.set(aabb.x + aabb.width * 0.5, aabb.y + aabb.height * 0.5, circle.node.worldPosition.z);
        radiusOut.x = Math.min(aabb.width, aabb.height) * 0.5;
    }

    /**
     * 将参考点投影到轮盘圆碰撞块周长上距离最近的点。
     * 参考点与圆心重合时，改用飞刀当前位置相对圆心的方向作为投影射线。
     */
    private cacheClosestPointOnCirclePerimeterWorld(
        wheelCircle: CircleCollider2D,
        referenceX: number,
        referenceY: number,
        knife: Node,
        out: Vec3,
    ) {
        this.cacheCircleColliderWorldShape(wheelCircle, this.tempC, this.tempKnifeRotatedOffset);
        const centerX = this.tempC.x;
        const centerY = this.tempC.y;
        const radius = this.tempKnifeRotatedOffset.x;
        const centerZ = this.tempC.z;

        let dirX = referenceX - centerX;
        let dirY = referenceY - centerY;
        let dirLenSq = dirX * dirX + dirY * dirY;

        if (dirLenSq <= Number.EPSILON) {
            knife.getWorldPosition(out);
            dirX = out.x - centerX;
            dirY = out.y - centerY;
            dirLenSq = dirX * dirX + dirY * dirY;
            if (dirLenSq <= Number.EPSILON) {
                dirX = 0;
                dirY = 1;
                dirLenSq = 1;
            }
        }

        const dirLen = Math.sqrt(dirLenSq);
        out.set(
            centerX + (dirX / dirLen) * radius,
            centerY + (dirY / dirLen) * radius,
            centerZ,
        );
    }

    private accumulateOverlapSample(acc: { sumX: number; sumY: number; count: number }, x: number, y: number) {
        acc.sumX += x;
        acc.sumY += y;
        acc.count += 1;
    }

    private isPointInCircle(x: number, y: number, centerX: number, centerY: number, radius: number): boolean {
        const dx = x - centerX;
        const dy = y - centerY;
        return dx * dx + dy * dy <= radius * radius + Number.EPSILON;
    }

    private isPointInPolygon(x: number, y: number, points: ReadonlyArray<{ x: number; y: number }>): boolean {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
            const xi = points[i].x;
            const yi = points[i].y;
            const xj = points[j].x;
            const yj = points[j].y;
            const intersect = (yi > y) !== (yj > y)
                && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
            if (intersect) {
                inside = !inside;
            }
        }
        return inside;
    }

    private accumulateSegmentCircleIntersections(
        acc: { sumX: number; sumY: number; count: number },
        ax: number,
        ay: number,
        bx: number,
        by: number,
        centerX: number,
        centerY: number,
        radius: number,
    ) {
        const dx = bx - ax;
        const dy = by - ay;
        const fx = ax - centerX;
        const fy = ay - centerY;

        const a = dx * dx + dy * dy;
        if (a <= Number.EPSILON) {
            return;
        }

        const b = 2 * (fx * dx + fy * dy);
        const c = fx * fx + fy * fy - radius * radius;
        let discriminant = b * b - 4 * a * c;
        if (discriminant < 0) {
            return;
        }

        discriminant = Math.sqrt(Math.max(0, discriminant));
        const t1 = (-b - discriminant) / (2 * a);
        const t2 = (-b + discriminant) / (2 * a);

        if (t1 >= 0 && t1 <= 1) {
            this.accumulateOverlapSample(acc, ax + dx * t1, ay + dy * t1);
        }
        if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > Number.EPSILON) {
            this.accumulateOverlapSample(acc, ax + dx * t2, ay + dy * t2);
        }
    }

    /** 根据剑尖在 middle 本地坐标计算“刀柄沿半径向外”的目标角度 */
    private getAttachedKnifeTargetAngle(tipLocalPos: Readonly<Vec3>): number {
        const localRad = Math.atan2(tipLocalPos.y, tipLocalPos.x);
        return localRad * (180 / Math.PI) + this.attachedKnifeAngleOffset;
    }

    /**
     * 立正动画：仅旋转角度，位置不变。
     * 锚点在剑尖时，Cocos 会绕锚点旋转，剑尖自然保持命中点不动。
     * 旋转方向取与目标角度的最小角差，并通过独立 tween 目标线性插值角度。
     */
    private playKnifeAlignAnimation(knife: Node, targetAngle: number) {
        const duration = Math.max(0.01, this.attachedKnifeAlignDuration);
        const startAngle = knife.angle;
        const shortestDelta = this.getShortestAngleDelta(startAngle, targetAngle);
        const endAngle = startAngle + shortestDelta;

        if (Math.abs(shortestDelta) <= 0.05) {
            knife.angle = endAngle;
            return;
        }

        // 不要 tween(knife).angle：Cocos 对 angle 的插值在跨 ±180/360 时可能走大角路径。
        Tween.stopAllByTarget(this.knifeAlignTweenTarget);
        Tween.stopAllByTarget(knife);
        this.knifeAlignTweenTarget.angle = startAngle;
        tween(this.knifeAlignTweenTarget)
            .to(duration, { angle: endAngle }, {
                easing: 'sineOut',
                onUpdate: () => {
                    if (knife.isValid) {
                        knife.angle = this.knifeAlignTweenTarget.angle;
                    }
                },
            })
            .call(() => {
                if (knife.isValid) {
                    knife.angle = endAngle;
                }
            })
            .start();
    }

    /** 返回从 fromAngle 转到 toAngle 的最小角差（范围 (-180, 180]） */
    private getShortestAngleDelta(fromAngle: number, toAngle: number): number {
        let delta = toAngle - fromAngle;
        // JS 的 % 对负数结果仍为负，需先转到 [0, 360) 再折返到最短路径。
        delta = (delta % 360 + 360) % 360;
        if (delta > 180) {
            delta -= 360;
        }
        return delta;
    }

    /**
     * 锚点在剑尖时，节点 position 不代表刀身质量中心。
     * 调速采样改用刀身几何中心（相对剑尖锚点的本地偏移）。
     */
    private cacheKnifeMassCenterLocalOffset(knife: Node, out: Vec3) {
        const uiTransform = knife.getComponent(UITransform);
        if (uiTransform) {
            out.set(
                (0.5 - uiTransform.anchorPoint.x) * uiTransform.width,
                (0.5 - uiTransform.anchorPoint.y) * uiTransform.height,
                0,
            );
            return;
        }

        const polygon = knife.getComponent(PolygonCollider2D);
        if (polygon && polygon.points.length > 0) {
            let sumX = 0;
            let sumY = 0;
            for (const point of polygon.points) {
                sumX += point.x;
                sumY += point.y;
            }
            out.set(sumX / polygon.points.length, sumY / polygon.points.length, 0);
            return;
        }

        out.set(0, -120, 0);
    }

    private cacheKnifeMassCenterInParent(knife: Node, out: Vec3) {
        this.cacheKnifeMassCenterLocalOffset(knife, this.tempKnifeLocalOffset);
        this.rotateVec2ByAngle(this.tempKnifeLocalOffset, knife.angle, this.tempKnifeRotatedOffset);
        out.set(
            knife.position.x + this.tempKnifeRotatedOffset.x,
            knife.position.y + this.tempKnifeRotatedOffset.y,
            knife.position.z,
        );
    }

    private rotateVec2ByAngle(localOffset: Vec3, angleDeg: number, out: Vec3) {
        const rad = angleDeg * (Math.PI / 180);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        out.set(
            localOffset.x * cos - localOffset.y * sin,
            localOffset.x * sin + localOffset.y * cos,
            0,
        );
    }

    public playHitShake(onComplete?: () => void) {
        this.cacheBaseLocalPosition();
        if (!this.wheelBasePosCached) {
            onComplete?.();
            return;
        }

        const shakeDistance = Math.max(0, this.wheelHitShakeDistance);
        const halfDuration = Math.max(0.01, this.wheelHitShakeHalfDuration);
        const repeatCount = Math.max(1, Math.floor(this.wheelHitShakeRepeatCount));
        if (shakeDistance <= Number.EPSILON) {
            this.resetWheelShake(true);
            onComplete?.();
            return;
        }

        // 每次命中只复位中间层抖动，外层左右移动继续按当前相位推进。
        this.resetWheelShake(true);

        this.wheelShakeUpLocalPos.set(0, shakeDistance, 0);
        this.wheelShakeDownLocalPos.set(0, -shakeDistance, 0);

        this.hitShakeTweenTarget.offsetY = 0;
        let shakeTween = tween(this.hitShakeTweenTarget);
        for (let i = 0; i < repeatCount; i += 1) {
            shakeTween = shakeTween
                .to(halfDuration, { offsetY: this.wheelShakeUpLocalPos.y }, {
                    onUpdate: (target) => this.updateHitShakeOffset(target?.offsetY ?? 0),
                })
                .to(halfDuration, { offsetY: this.wheelShakeDownLocalPos.y }, {
                    onUpdate: (target) => this.updateHitShakeOffset(target?.offsetY ?? 0),
                });
        }
        shakeTween
            .to(halfDuration, { offsetY: 0 }, {
                onUpdate: (target) => this.updateHitShakeOffset(target?.offsetY ?? 0),
            })
            .call(() => {
                this.updateHitShakeOffset(0);
                onComplete?.();
            })
            .start();
    }

    /**
     * 失败特写前置：将所有相关飞刀挂到 middle，并停止其独立 tween。
     * 必须在 stopTweensAndResetTransform 之前调用，确保轮盘归位/缩放时飞刀同步跟随。
     */
    public prepareFailFocusKnives(knives: Node[]) {
        this.ensureWheelHierarchy();
        for (const knife of knives) {
            if (!knife || !knife.isValid) {
                continue;
            }
            Tween.stopAllByTarget(knife);
            this.reparentKnifeToAttachedLayer(knife);
        }
    }

    public playFailFocusEffect(collidedKnives: Node[], durationSeconds: number, focusScaleValue: number, blinkIntervalSeconds: number, onComplete: () => void) {
        const validCollidedKnives = collidedKnives.filter((knife) => knife && knife.isValid);
        if (validCollidedKnives.length === 0) {
            onComplete();
            return;
        }

        this.cacheBaseScale();
        this.ensureWheelHierarchy();

        // 兜底：若外部未先 prepare，这里再挂到 middle，保证与轮盘同层级树。
        for (const knife of validCollidedKnives) {
            this.reparentKnifeToAttachedLayer(knife);
        }

        const duration = Math.max(0.1, durationSeconds);
        const blinkInterval = Math.max(0.05, blinkIntervalSeconds);
        const focusScale = Math.max(1, focusScaleValue);
        const originalSpriteColors: Array<{ sprite: Sprite; color: Color }> = [];
        for (const knife of validCollidedKnives) {
            originalSpriteColors.push(...this.collectKnifeSpriteColors(knife));
        }

        // 直接 tween focus 节点 scale，middle 下所有飞刀与轮盘视觉同一帧同步缩放。
        const outerNode = this.outerNode ?? this.node;
        const focusNode = this.focusNode ?? outerNode;
        if (this.wheelBaseScaleCached) {
            this.playFailFocusCameraMove(validCollidedKnives, focusScale, outerNode, focusNode);
        }

        const blinkTimes = Math.max(1, Math.floor(duration / blinkInterval));
        Tween.stopAllByTarget(this.failFocusBlinkTweenTarget);
        let blinkTween = tween(this.failFocusBlinkTweenTarget);
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
                // 特写结束：镜头与缩放一并归位，避免只缩放回弹时焦点偏离屏幕中心。
                Tween.stopAllByTarget(this.failFocusCameraTweenTarget);
                this.resetWheelToBasePosition(false);
                this.resetWheelToBaseScale(false);
                this.restoreKnifeSpriteColors(originalSpriteColors);
                for (const knife of validCollidedKnives) {
                    if (knife.isValid) {
                        this.setKnifeSpritesColor(knife, this.failBlinkRedColor);
                    }
                }
                onComplete();
            })
            .start();
    }

    /** 将飞刀挂到 middle 层（与已附着飞刀同层），保留世界变换 */
    private reparentKnifeToAttachedLayer(knife: Node) {
        this.ensureWheelHierarchy();
        const attachParent = this.middleNode ?? this.node;
        if (knife.parent === attachParent) {
            return;
        }

        Tween.stopAllByTarget(knife);
        knife.setParent(attachParent, true);
    }

    public stopTweensAndResetTransform() {
        this.resetWheelToBasePosition(true);
        this.resetWheelToBaseScale(true);
    }

    /** 失败特写前：只复位抖动与缩放，保留 outer 当前水平位置，避免特写前跳帧 */
    public stopTweensAndResetForFailFocus() {
        this.resetWheelShake(true);
        this.resetWheelToBaseScale(true);
        Tween.stopAllByTarget(this.failFocusCameraTweenTarget);
    }

    /**
     * 失败特写镜头：以两把飞刀碰撞交集中心为锚点，同步平移 outer + 放大 focus，
     * 使事故焦点平滑移动到屏幕中心，模拟镜头对准并推近。
     */
    private playFailFocusCameraMove(
        collidedKnives: Node[],
        focusScaleValue: number,
        outerNode: Node,
        focusNode: Node,
    ) {
        const targetScale = Math.max(1, this.wheelBaseScale.x * focusScaleValue);
        let hasFocalPoint = false;

        if (collidedKnives.length >= 2) {
            hasFocalPoint = this.cacheKnivesOverlapCenterWorld(collidedKnives[0], collidedKnives[1], this.tempA);
        }
        if (!hasFocalPoint && collidedKnives.length > 0) {
            collidedKnives[0].getWorldPosition(this.tempA);
            hasFocalPoint = true;
        }
        if (!hasFocalPoint) {
            outerNode.getWorldPosition(this.tempA);
        }

        outerNode.getWorldPosition(this.tempB);
        this.cacheScreenCenterWorld(this.tempC);

        const state = this.failFocusCameraState;
        state.outerStartWorldX = this.tempB.x;
        state.outerStartWorldY = this.tempB.y;
        state.outerStartWorldZ = this.tempB.z;
        state.focalVectorX = this.tempA.x - this.tempB.x;
        state.focalVectorY = this.tempA.y - this.tempB.y;
        state.targetFocusScale = targetScale;
        state.outerEndWorldX = this.tempC.x - targetScale * state.focalVectorX;
        state.outerEndWorldY = this.tempC.y - targetScale * state.focalVectorY;

        this.failFocusCameraTweenTarget.progress = 0;
        Tween.stopAllByTarget(this.failFocusCameraTweenTarget);
        Tween.stopAllByTarget(outerNode);
        Tween.stopAllByTarget(focusNode);

        const moveDuration = Math.max(0.01, this.failFocusMoveDuration);
        tween(this.failFocusCameraTweenTarget)
            .to(moveDuration, { progress: 1 }, {
                easing: 'sineOut',
                onUpdate: () => {
                    this.applyFailFocusCameraTransform(outerNode, focusNode, this.failFocusCameraTweenTarget.progress);
                },
            })
            .start();
    }

    /** 按镜头进度同步更新 outer 世界位置与 focus 缩放 */
    private applyFailFocusCameraTransform(outerNode: Node, focusNode: Node, progress: number) {
        const state = this.failFocusCameraState;
        const t = Math.min(1, Math.max(0, progress));
        const startScale = this.wheelBaseScale.x;
        const currentScale = startScale + (state.targetFocusScale - startScale) * t;
        const outerWorldX = state.outerStartWorldX + (state.outerEndWorldX - state.outerStartWorldX) * t;
        const outerWorldY = state.outerStartWorldY + (state.outerEndWorldY - state.outerStartWorldY) * t;

        this.tempA.set(outerWorldX, outerWorldY, state.outerStartWorldZ);
        this.setOuterWorldPosition(outerNode, this.tempA);
        focusNode.setScale(currentScale, currentScale, this.wheelBaseScale.z);
    }

    /** 将 outer 节点设到指定世界坐标（转换到父节点本地空间） */
    private setOuterWorldPosition(outerNode: Node, worldPos: Readonly<Vec3>) {
        const parent = outerNode.parent;
        if (parent) {
            parent.inverseTransformPoint(this.tempC, worldPos);
            outerNode.setPosition(this.tempC);
            return;
        }
        outerNode.setWorldPosition(worldPos);
    }

    /** 屏幕中心的世界坐标（Canvas 锚点在屏幕中心） */
    private cacheScreenCenterWorld(out: Vec3) {
        const canvasNode = this.outerNode?.parent ?? this.node.parent;
        if (canvasNode) {
            canvasNode.getWorldPosition(out);
            return;
        }
        const visibleSize = view.getVisibleSize();
        out.set(visibleSize.width * 0.5, visibleSize.height * 0.5, 0);
    }

    /** 计算两把飞刀 PolygonCollider2D 碰撞交集区域的中心（世界坐标） */
    private cacheKnivesOverlapCenterWorld(knifeA: Node, knifeB: Node, out: Vec3): boolean {
        const polyA = this.getKnifePolygonCollider(knifeA);
        const polyB = this.getKnifePolygonCollider(knifeB);
        if (!polyA || !polyB) {
            return false;
        }

        const pointsA = polyA.worldPoints;
        const pointsB = polyB.worldPoints;
        if (pointsA.length < 3 || pointsB.length < 3) {
            return false;
        }

        const acc = this.overlapSampleAccumulator;
        acc.sumX = 0;
        acc.sumY = 0;
        acc.count = 0;

        for (const point of pointsA) {
            if (this.isPointInPolygon(point.x, point.y, pointsB)) {
                this.accumulateOverlapSample(acc, point.x, point.y);
            }
        }
        for (const point of pointsB) {
            if (this.isPointInPolygon(point.x, point.y, pointsA)) {
                this.accumulateOverlapSample(acc, point.x, point.y);
            }
        }
        for (let i = 0; i < pointsA.length; i += 1) {
            const a1 = pointsA[i];
            const a2 = pointsA[(i + 1) % pointsA.length];
            for (let j = 0; j < pointsB.length; j += 1) {
                const b1 = pointsB[j];
                const b2 = pointsB[(j + 1) % pointsB.length];
                this.accumulateSegmentSegmentIntersection(
                    acc,
                    a1.x,
                    a1.y,
                    a2.x,
                    a2.y,
                    b1.x,
                    b1.y,
                    b2.x,
                    b2.y,
                );
            }
        }

        if (acc.count > 0) {
            out.set(acc.sumX / acc.count, acc.sumY / acc.count, knifeA.worldPosition.z);
            return true;
        }

        return this.cachePolygonPairAabbOverlapCenterWorld(pointsA, pointsB, out, knifeA.worldPosition.z);
    }

    private cachePolygonPairAabbOverlapCenterWorld(
        pointsA: ReadonlyArray<{ x: number; y: number }>,
        pointsB: ReadonlyArray<{ x: number; y: number }>,
        out: Vec3,
        worldZ: number,
    ): boolean {
        let minAx = Number.POSITIVE_INFINITY;
        let minAy = Number.POSITIVE_INFINITY;
        let maxAx = Number.NEGATIVE_INFINITY;
        let maxAy = Number.NEGATIVE_INFINITY;
        for (const point of pointsA) {
            minAx = Math.min(minAx, point.x);
            minAy = Math.min(minAy, point.y);
            maxAx = Math.max(maxAx, point.x);
            maxAy = Math.max(maxAy, point.y);
        }

        let minBx = Number.POSITIVE_INFINITY;
        let minBy = Number.POSITIVE_INFINITY;
        let maxBx = Number.NEGATIVE_INFINITY;
        let maxBy = Number.NEGATIVE_INFINITY;
        for (const point of pointsB) {
            minBx = Math.min(minBx, point.x);
            minBy = Math.min(minBy, point.y);
            maxBx = Math.max(maxBx, point.x);
            maxBy = Math.max(maxBy, point.y);
        }

        const overlapMinX = Math.max(minAx, minBx);
        const overlapMinY = Math.max(minAy, minBy);
        const overlapMaxX = Math.min(maxAx, maxBx);
        const overlapMaxY = Math.min(maxAy, maxBy);
        if (overlapMaxX < overlapMinX || overlapMaxY < overlapMinY) {
            return false;
        }

        out.set(
            (overlapMinX + overlapMaxX) * 0.5,
            (overlapMinY + overlapMaxY) * 0.5,
            worldZ,
        );
        return true;
    }

    private accumulateSegmentSegmentIntersection(
        acc: { sumX: number; sumY: number; count: number },
        ax: number,
        ay: number,
        bx: number,
        by: number,
        cx: number,
        cy: number,
        dx: number,
        dy: number,
    ) {
        const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
        if (Math.abs(denom) <= Number.EPSILON) {
            return;
        }

        const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
        const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
        if (t < 0 || t > 1 || u < 0 || u > 1) {
            return;
        }

        this.accumulateOverlapSample(acc, ax + (bx - ax) * t, ay + (by - ay) * t);
    }

    /** 仅复位中间层命中抖动，不影响外层左右移动相位与位置 */
    public resetWheelShake(stopShakeTween = true) {
        this.ensureWheelHierarchy();
        if (stopShakeTween) {
            Tween.stopAllByTarget(this.hitShakeTweenTarget);
        }
        this.hitShakeOffsetY = 0;
        this.applyMiddleShakePosition();
    }

    /** 复位外层位置（含左右移动相位）与中间层抖动，用于新回合/结算归位 */
    public resetWheelToBasePosition(stopShakeTween = true) {
        this.ensureWheelHierarchy();
        this.cacheBaseLocalPosition();
        if (!this.wheelBasePosCached) {
            return;
        }

        const outerNode = this.outerNode ?? this.node;
        if (stopShakeTween) {
            Tween.stopAllByTarget(outerNode);
        }
        this.resetWheelShake(stopShakeTween);
        this.horizontalMoveElapsed = 0;
        this.applyOuterLocalPosition();
    }

    private updateHitShakeOffset(offsetY: number) {
        this.hitShakeOffsetY = offsetY;
        this.applyMiddleShakePosition();
    }

    /** 外层只负责基准位置 + 左右往返偏移，不再叠加抖动 Y 偏移 */
    private applyOuterLocalPosition() {
        if (!this.wheelBasePosCached) {
            return;
        }

        const outerNode = this.outerNode ?? this.node;
        const period = Math.max(0.01, this.horizontalMovePeriod);
        const movePhase = this.horizontalMoveEnabled ? (this.horizontalMoveElapsed / period) * Math.PI * 2 : 0;
        const moveOffsetX = this.horizontalMoveEnabled ? Math.sin(movePhase) * Math.max(0, this.horizontalMoveDistance) : 0;
        outerNode.setPosition(
            this.wheelBaseLocalPos.x + moveOffsetX,
            this.wheelBaseLocalPos.y,
            this.wheelBaseLocalPos.z,
        );
    }

    /** 中间层只负责命中上下抖动，本地 X/Z 保持为 0 */
    private applyMiddleShakePosition() {
        if (!this.middleNode) {
            return;
        }
        this.middleNode.setPosition(0, this.hitShakeOffsetY, 0);
    }

    /** 兼容旧调用名：左右移动走外层位置刷新 */
    private applyWheelLocalPosition() {
        this.applyOuterLocalPosition();
    }

    public resetWheelToBaseScale(stopScaleTween = true) {
        this.ensureWheelHierarchy();
        this.cacheBaseScale();
        if (!this.wheelBaseScaleCached) {
            return;
        }

        const focusNode = this.focusNode ?? this.outerNode ?? this.node;
        if (stopScaleTween) {
            Tween.stopAllByTarget(focusNode);
            Tween.stopAllByTarget(this.failFocusBlinkTweenTarget);
            Tween.stopAllByTarget(this.failFocusCameraTweenTarget);
        }
        focusNode.setScale(this.wheelBaseScale);
    }

    /**
     * 确保轮盘四层结构存在：
     * - 外层（this.node）：左右移动
     * - 特写层（focus）：失败慢镜头缩放
     * - 中间层（middle）：自转、命中抖动
     * - 内层（body）：视觉与碰撞体
     */
    private ensureWheelHierarchy() {
        if (this.wheelLayersReady && this.outerNode && this.focusNode && this.middleNode && this.bodyNode) {
            return;
        }

        this.outerNode = this.node;
        let hierarchyChanged = false;

        // 1) 特写层：位于 outer 与 middle 之间，缩放 pivot 对齐轮盘内容中心。
        let focus = this.focusLayer;
        if (!focus || !focus.isValid) {
            focus = this.outerNode.getChildByName(WHEEL_FOCUS_LAYER_NAME);
        }
        if (!focus) {
            focus = new Node(WHEEL_FOCUS_LAYER_NAME);
            focus.setParent(this.outerNode, false);
            focus.setPosition(0, 0, 0);
            focus.setRotationFromEuler(0, 0, 0);
            focus.setScale(1, 1, 1);

            const outerChildren = [...this.outerNode.children];
            for (const child of outerChildren) {
                if (child === focus) {
                    continue;
                }
                child.setParent(focus, true);
            }
            hierarchyChanged = true;
        }
        this.focusNode = focus;
        this.focusLayer = focus;

        // 2) 中间层：挂在 focus 下，负责自转与命中抖动。
        let middle = this.middleLayer;
        if (!middle || !middle.isValid) {
            middle = focus.getChildByName(WHEEL_MIDDLE_LAYER_NAME);
        }
        if (!middle) {
            middle = new Node(WHEEL_MIDDLE_LAYER_NAME);
            middle.setParent(focus, false);
            middle.setPosition(0, 0, 0);
            middle.setRotationFromEuler(0, 0, 0);
            middle.setScale(1, 1, 1);

            const focusChildren = [...focus.children];
            for (const child of focusChildren) {
                if (child === middle) {
                    continue;
                }
                child.setParent(middle, true);
            }
            hierarchyChanged = true;
        } else if (middle.parent !== focus) {
            middle.setParent(focus, true);
            hierarchyChanged = true;
        }
        this.middleNode = middle;
        this.middleLayer = middle;

        let body = this.bodyLayer;
        if (!body || !body.isValid) {
            body = middle.getChildByName(WHEEL_BODY_LAYER_NAME);
        }
        if (!body) {
            body = middle.children.length > 0 ? middle.children[0] : middle;
        }
        this.bodyNode = body;
        this.bodyLayer = body;

        if (hierarchyChanged) {
            this.wheelBaseScaleCached = false;
        }
        this.migrateColliderToRotateLayerIfNeeded();
        this.wheelLayersReady = true;
    }

    /**
     * 旧场景把 Collider2D 挂在外层 wheel 上且与自转同节点。
     * 拆分层级后碰撞体必须跟随中间层自转，因此检测到外层 collider 时自动迁移到 middle。
     */
    private migrateColliderToRotateLayerIfNeeded() {
        const outer = this.outerNode;
        const middle = this.middleNode;
        if (!outer || !middle) {
            return;
        }

        const outerCollider = outer.getComponent(Collider2D);
        if (!outerCollider) {
            return;
        }

        const rotateLayerCollider = middle.getComponent(Collider2D)
            ?? middle.getComponentInChildren(Collider2D);
        if (rotateLayerCollider) {
            outerCollider.destroy();
            return;
        }

        const migratedCollider = this.cloneColliderToNode(outerCollider, middle);
        if (migratedCollider) {
            outerCollider.destroy();
        }
    }

    private cloneColliderToNode(source: Collider2D, targetNode: Node): Collider2D | null {
        let cloned: Collider2D | null = null;
        if (source instanceof CircleCollider2D) {
            const circle = targetNode.addComponent(CircleCollider2D);
            circle.radius = source.radius;
            cloned = circle;
        } else if (source instanceof PolygonCollider2D) {
            const polygon = targetNode.addComponent(PolygonCollider2D);
            polygon.points = source.points.map((point) => new Vec2(point.x, point.y));
            cloned = polygon;
        } else {
            console.warn('[WheelController] 外层 Collider2D 类型暂不支持自动迁移，请在编辑器中将其移到 middle/body 节点。');
            return null;
        }

        cloned.offset = source.offset.clone();
        cloned.tag = source.tag;
        cloned.group = source.group;
        cloned.density = source.density;
        cloned.sensor = source.sensor;
        cloned.friction = source.friction;
        cloned.restitution = source.restitution;
        return cloned;
    }

    private cacheCollider() {
        this.ensureWheelHierarchy();
        const middle = this.middleNode ?? this.node;
        const outer = this.outerNode ?? this.node;

        // 碰撞体通常挂在 middle 自身；也可能挂在 body 子节点。
        // 不能从 body 向上搜，因此必须以 middle 为根向下查找。
        this.wheelCollider = middle.getComponent(Collider2D)
            ?? middle.getComponentInChildren(Collider2D)
            ?? outer.getComponent(Collider2D);

        if (!this.wheelCollider) {
            console.warn('[WheelController] 轮盘 middle/body 缺少 Collider2D，无法进行“飞刀 vs 轮盘”的碰撞判定。');
        }
    }

    private getCollider(): Collider2D | null {
        if (!this.wheelCollider || !this.wheelCollider.isValid) {
            this.cacheCollider();
        }
        return this.wheelCollider;
    }

    private cacheBaseLocalPosition() {
        if (this.wheelBasePosCached) {
            return;
        }
        const outerNode = this.outerNode ?? this.node;
        outerNode.getPosition(this.wheelBaseLocalPos);
        this.wheelBasePosCached = true;
    }

    private cacheBaseScale() {
        if (this.wheelBaseScaleCached) {
            return;
        }
        this.ensureWheelHierarchy();
        const focusNode = this.focusNode ?? this.outerNode ?? this.node;
        focusNode.getScale(this.wheelBaseScale);
        this.wheelBaseScaleCached = true;
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
            this.cacheKnifeMassCenterInParent(knife, this.tempC);
            centerX += this.tempC.x;
            centerY += this.tempC.y;
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
        const middleAngle = this.middleNode?.angle ?? this.node.angle;
        const worldImbalanceAngle = localImbalanceAngle + middleAngle * (Math.PI / 180);
        const influence = Math.max(0, this.wheelImbalanceInfluence);

        // 2D 力矩 r x F 的近似：偏重侧上升时减速，下降时加速，最低点附近保留惯性。
        const gravityTorque = -Math.cos(worldImbalanceAngle) * normalizedImbalance * influence;
        return gravityTorque * Math.abs(this.wheelRotateSpeed);
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
        return this.isPolygonOverlapBySAT(a.worldPoints, b.worldPoints);
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
}
