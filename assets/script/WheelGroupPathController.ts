import { _decorator, Component, Node, Sprite, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

/**
 * 轮盘组轨迹控制器：挂在 gp_wheel 上，让各子轮盘沿 gp_path 路点有序移动（贪吃蛇）。
 * - pathRoot 子节点顺序即轨迹折线顺序；
 * - 第一个子轮盘为蛇头，后续轮盘按 snakeSpacing 沿轨迹落后跟随。
 */
@ccclass('WheelGroupPathController')
export class WheelGroupPathController extends Component {
    @property({ type: Node, tooltip: '轨迹节点组 gp_path，其子节点顺序即路径路点' })
    public pathRoot: Node | null = null;

    @property({ tooltip: '蛇头沿轨迹前进速度（像素/秒）' })
    public moveSpeed = 140;

    @property({ tooltip: '相邻轮盘在轨迹上的间距（像素）' })
    public snakeSpacing = 200;

    @property({ tooltip: '轨迹是否首尾闭合循环' })
    public loopPath = true;

    /** 轨迹路点（gp_wheel 本地坐标） */
    private readonly pathPoints: Vec3[] = [];
    /** 每段折线长度，与 pathPoints 段一一对应 */
    private readonly segmentLengths: number[] = [];
    private totalPathLength = 0;
    /** 蛇头在轨迹上的累计路程（像素） */
    private headDistance = 0;
    /** gp_wheel 下参与移动的轮盘子节点（按 sibling 顺序） */
    private readonly wheelNodes: Node[] = [];
    /** 记录初始 sibling 顺序，失败特写提层后可在新一局恢复 */
    private readonly savedWheelRenderOrder: Node[] = [];
    private movementPaused = false;
    private pathReady = false;

    private readonly tempWorld = new Vec3();
    private readonly tempLocal = new Vec3();
    private readonly tempSample = new Vec3();

    public initialize() {
        // 场景加载后第一时间去掉路点上的 Sprite，避免编辑器标记图块残留在游戏中。
        this.stripPathWaypointSprites();
        this.collectWheelNodes();
        this.rebuildPath();
        this.resetToStart();
    }

    /** 移除 gp_path 各路径点子节点上的 Sprite（仅作编辑器路点标记，运行时不需要显示） */
    private stripPathWaypointSprites() {
        if (!this.pathRoot || !this.pathRoot.isValid) {
            return;
        }

        for (const waypoint of this.pathRoot.children) {
            if (!waypoint || !waypoint.isValid) {
                continue;
            }
            const sprites = waypoint.getComponents(Sprite);
            for (const sprite of sprites) {
                if (sprite && sprite.isValid) {
                    sprite.destroy();
                }
            }
        }
    }

    /** 每帧推进蛇头并刷新各轮盘位置 */
    public updateMovement(deltaTime: number) {
        if (this.movementPaused || !this.pathReady || this.wheelNodes.length === 0) {
            return;
        }

        const speed = Math.max(0, this.moveSpeed);
        if (speed <= Number.EPSILON) {
            this.applySnakePositions();
            return;
        }

        this.headDistance += speed * deltaTime;
        if (this.loopPath && this.totalPathLength > Number.EPSILON) {
            this.headDistance = this.modPositive(this.headDistance, this.totalPathLength);
        } else if (this.totalPathLength > Number.EPSILON) {
            this.headDistance = Math.min(this.headDistance, this.totalPathLength);
        }

        this.applySnakePositions();
    }

    /** 暂停轨迹移动（失败/胜利特写时保持当前位置） */
    public pauseMovement() {
        this.movementPaused = true;
    }

    /** 恢复轨迹移动 */
    public resumeMovement() {
        this.movementPaused = false;
    }

    /** 新一局：恢复轮盘 sibling 顺序、蛇头回到轨迹起点 */
    public resetToStart() {
        this.restoreWheelRenderOrder();
        this.headDistance = 0;
        this.movementPaused = false;
        this.applySnakePositions();
    }

    /**
     * 失败特写前：将指定轮盘节点提到 gp_wheel 队尾（最后渲染），避免被其它轮盘遮挡。
     * 不改变 wheelNodes 内的贪吃蛇逻辑顺序，仅调整 UI 渲染层级。
     */
    public bringWheelToRenderFront(wheelNode: Node | null) {
        if (!wheelNode || !wheelNode.isValid || wheelNode.parent !== this.node) {
            return;
        }
        wheelNode.setSiblingIndex(this.node.children.length - 1);
    }

    /** 按 initialize 时记录的顺序恢复各轮盘 sibling 索引 */
    public restoreWheelRenderOrder() {
        for (let i = 0; i < this.savedWheelRenderOrder.length; i += 1) {
            const wheelNode = this.savedWheelRenderOrder[i];
            if (wheelNode && wheelNode.isValid && wheelNode.parent === this.node) {
                wheelNode.setSiblingIndex(i);
            }
        }
    }

    /** 重新读取 gp_path 路点（编辑器中调整路径后可调用） */
    public rebuildPath() {
        this.pathPoints.length = 0;
        this.segmentLengths.length = 0;
        this.totalPathLength = 0;
        this.pathReady = false;

        if (!this.pathRoot || !this.pathRoot.isValid) {
            console.warn('[WheelGroupPathController] 未绑定 pathRoot（gp_path），轮盘组无法沿轨迹移动。');
            return;
        }

        const wheelGroup = this.node;
        for (const waypoint of this.pathRoot.children) {
            if (!waypoint || !waypoint.isValid || !waypoint.active) {
                continue;
            }
            waypoint.getWorldPosition(this.tempWorld);
            wheelGroup.inverseTransformPoint(this.tempLocal, this.tempWorld);
            this.pathPoints.push(this.tempLocal.clone());
        }

        const pointCount = this.pathPoints.length;
        if (pointCount < 2) {
            console.warn('[WheelGroupPathController] gp_path 至少需要 2 个路点。');
            return;
        }

        const segmentCount = this.loopPath ? pointCount : pointCount - 1;
        for (let i = 0; i < segmentCount; i += 1) {
            const from = this.pathPoints[i];
            const to = this.pathPoints[(i + 1) % pointCount];
            const length = Vec3.distance(from, to);
            this.segmentLengths.push(length);
            this.totalPathLength += length;
        }

        this.pathReady = this.totalPathLength > Number.EPSILON;
    }

    /** 收集 gp_wheel 下所有轮盘子节点（仅一层子节点），并快照渲染顺序 */
    private collectWheelNodes() {
        this.wheelNodes.length = 0;
        this.savedWheelRenderOrder.length = 0;
        for (const child of this.node.children) {
            if (child && child.isValid && child.active) {
                this.wheelNodes.push(child);
                this.savedWheelRenderOrder.push(child);
            }
        }
    }

    /** 按当前 headDistance 与节距，更新每个轮盘在 gp_wheel 下的本地坐标 */
    private applySnakePositions() {
        if (!this.pathReady) {
            return;
        }

        for (let i = 0; i < this.wheelNodes.length; i += 1) {
            const wheelDistance = this.headDistance - i * Math.max(0, this.snakeSpacing);
            if (this.samplePathPosition(wheelDistance, this.tempSample)) {
                this.wheelNodes[i].setPosition(this.tempSample);
            }
        }
    }

    /**
     * 在轨迹上按路程采样位置（输出为 gp_wheel 本地坐标）。
     * loopPath 时支持负路程（表示从蛇头后方绕回轨迹尾部）。
     */
    private samplePathPosition(distance: number, out: Vec3): boolean {
        if (!this.pathReady || this.pathPoints.length < 2 || this.segmentLengths.length === 0) {
            return false;
        }

        let traveled = this.loopPath
            ? this.modPositive(distance, this.totalPathLength)
            : Math.min(Math.max(distance, 0), this.totalPathLength);

        for (let i = 0; i < this.segmentLengths.length; i += 1) {
            const segLen = this.segmentLengths[i];
            if (traveled <= segLen || i === this.segmentLengths.length - 1) {
                const t = segLen > Number.EPSILON ? traveled / segLen : 0;
                const p0 = this.pathPoints[i];
                const p1 = this.pathPoints[(i + 1) % this.pathPoints.length];
                out.set(
                    p0.x + (p1.x - p0.x) * t,
                    p0.y + (p1.y - p0.y) * t,
                    p0.z + (p1.z - p0.z) * t,
                );
                return true;
            }
            traveled -= segLen;
        }

        out.set(this.pathPoints[0]);
        return true;
    }

    private modPositive(value: number, modulus: number): number {
        if (modulus <= Number.EPSILON) {
            return 0;
        }
        return ((value % modulus) + modulus) % modulus;
    }
}
