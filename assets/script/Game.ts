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
    view,
} from 'cc';
import { WheelController } from './WheelController';
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

    @property({ tooltip: '飞刀上升速度（像素/秒）' })
    public knifeFlySpeed = 1200;

    @property({ tooltip: '连续生成/发射飞刀的最小时间间隔（秒）' })
    public knifeSpawnInterval = 0.2;

    @property({ tooltip: '撞飞刀失败时，慢动作特写和红色闪烁总时长（秒）' })
    public failFocusDuration = 2;
    
    @property({ tooltip: '撞飞刀失败时，慢动作特写放大倍数' })
    public failFocusScale = 1.12;
    
    @property({ tooltip: '撞飞刀失败时，红色闪烁单次切换间隔（秒）' })
    public failKnifeBlinkInterval = 0.15;
    
    private knifeScreenDestroyMargin = 120;
    
    private roundState: RoundState = RoundState.Idle;
    private currentKnife: Node | null = null;
    private flyingKnives: Node[] = [];
    private wheelController: WheelController | null = null;
    // 仅用于“失败瞬间保留失误飞刀显示”：
    // 这些节点会在下一局开始时统一销毁，避免跨局残留污染场景。
    private failedDisplayKnives: Node[] = [];
    private hitKnifeCount = 0;

    // 为了避免“点击继续游戏”后同一触摸事件立刻触发发射，这里增加一个极短输入锁。
    private elapsedSeconds = 0;
    private inputLockedUntil = 0;
    private nextKnifeSpawnAllowedAt = 0;

    // 复用临时向量，避免在 update 中频繁创建对象导致 GC 抖动。
    private readonly tempA = new Vec3();
    private readonly tempB = new Vec3();

    start() {
        this.bindInputEvents();
        this.cacheWheelController();
        this.startNewRound();
    }

    update(deltaTime: number) {
        this.elapsedSeconds += deltaTime;

        // 仅在“可进行中”的状态旋转轮盘；结算状态下保持静止，便于玩家看清结果。
        if ((this.roundState === RoundState.Idle || this.roundState === RoundState.KnifeFlying) && this.wheelController) {
            this.wheelController.updateWheelRotation(deltaTime);
        }

        if (this.roundState === RoundState.Idle || this.roundState === RoundState.KnifeFlying) {
            this.spawnWaitingKnifeWhenReady();
            this.updateFlyingKnives(deltaTime);
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
        if (this.roundState !== RoundState.Idle && this.roundState !== RoundState.KnifeFlying) {
            return;
        }
        this.throwCurrentKnife();
    }

    private onContinueGame() {
        this.startNewRound();
    }

    private cacheWheelController() {
        if (!this.wheel || !this.wheel.isValid) {
            this.wheelController = null;
            return;
        }

        // 兼容当前场景：如果轮盘节点还没有手动挂 WheelController，运行时自动补一个。
        // 后续支持多个轮盘时，推荐直接在每个轮盘节点上挂该组件并分别配置参数。
        this.wheelController = this.wheel.getComponent(WheelController) ?? this.wheel.addComponent(WheelController);
        this.wheelController.initialize();
    }

    private startNewRound() {
        this.cacheWheelController();
        if (!this.wheelController || !this.knifeSpawnPoint || !this.knifePrefab) {
            console.warn('[Game] 请先在编辑器中绑定 wheel / knifeSpawnPoint / knifePrefab。');
            return;
        }

        // 1) 清理旧局残留的飞刀（包括正在飞行和已附着）。
        if (this.currentKnife && this.currentKnife.isValid) {
            this.currentKnife.destroy();
        }
        this.currentKnife = null;
        for (const knife of this.flyingKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.flyingKnives.length = 0;
        this.wheelController.resetForNewRound();
        for (const knife of this.failedDisplayKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.failedDisplayKnives.length = 0;

        // 2) 重置计数、状态、界面可见性。
        this.hitKnifeCount = 0;
        this.roundState = RoundState.Idle;
        this.nextKnifeSpawnAllowedAt = this.elapsedSeconds;
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
        if (!this.currentKnife || this.elapsedSeconds < this.nextKnifeSpawnAllowedAt) {
            return;
        }
        this.flyingKnives.push(this.currentKnife);
        this.currentKnife = null;
        this.nextKnifeSpawnAllowedAt = this.elapsedSeconds + Math.max(0, this.knifeSpawnInterval);
        this.roundState = RoundState.KnifeFlying;
    }

    private spawnWaitingKnifeWhenReady() {
        if (this.currentKnife || this.elapsedSeconds < this.nextKnifeSpawnAllowedAt) {
            return;
        }
        this.spawnWaitingKnife();
    }

    private getKnifeCollider(knife: Node | null): Collider2D | null {
        if (!knife || !knife.isValid) {
            return null;
        }
        return knife.getComponent(Collider2D);
    }

    private updateFlyingKnives(deltaTime: number) {
        if (!this.wheelController) {
            this.failRound();
            return;
        }

        for (let i = this.flyingKnives.length - 1; i >= 0; i -= 1) {
            const flyingKnife = this.flyingKnives[i];
            if (!flyingKnife || !flyingKnife.isValid) {
                this.flyingKnives.splice(i, 1);
                continue;
            }

            // 飞刀每帧沿世界 Y 轴正方向直线移动，允许多把飞刀同时处于飞行状态。
            flyingKnife.getWorldPosition(this.tempA);
            this.tempB.set(this.tempA);
            this.tempB.y += this.knifeFlySpeed * deltaTime;
            flyingKnife.setWorldPosition(this.tempB);

            // 按规则优先检查“飞刀撞已附着飞刀”的失败条件。
            const hitAttachedKnife = this.wheelController.getHitAttachedKnifeByCollider(flyingKnife);
            if (hitAttachedKnife) {
                // 撞到已附着飞刀时保留失误飞刀，进入失败特写。
                this.flyingKnives.splice(i, 1);
                this.failRound(false, hitAttachedKnife, flyingKnife);
                return;
            }

            // 再检查“飞刀撞轮盘”的成功条件，命中后立刻附着到对应轮盘。
            if (this.wheelController.checkKnifeHitWheel(flyingKnife)) {
                this.flyingKnives.splice(i, 1);
                this.attachFlyingKnifeToWheelByCurrentWorldPos(flyingKnife);
                if (this.roundState === RoundState.RoundWin) {
                    return;
                }
                continue;
            }

            // 飞刀允许不命中任何轮盘；飞出屏幕后直接销毁，不再触发失败。
            if (this.isKnifeOutOfScreen(this.tempB)) {
                this.flyingKnives.splice(i, 1);
                flyingKnife.destroy();
            }
        }

        if (this.flyingKnives.length === 0 && this.roundState === RoundState.KnifeFlying) {
            this.roundState = RoundState.Idle;
        }
    }

    private isKnifeOutOfScreen(currWorldPos: Vec3): boolean {
        const visibleSize = view.getVisibleSize();
        return currWorldPos.y > visibleSize.height + this.knifeScreenDestroyMargin;
    }

    private showFailPanel() {
        if (this.failPanel) {
            this.failPanel.active = true;
        }
    }

    private attachFlyingKnifeToWheelByCurrentWorldPos(flyingKnife: Node) {
        if (!flyingKnife || !flyingKnife.isValid || !this.wheelController) {
            return;
        }

        this.wheelController.attachKnifeAtCurrentWorldPosition(flyingKnife);

        this.hitKnifeCount += 1;
        this.refreshProgressText();

        if (this.hitKnifeCount >= this.targetKnifeCount) {
            // 最后一刀也要完整播放命中反馈：
            // 先把状态切到胜利，阻止 update 继续驱动飞刀；再等待抖动结束后弹出胜利面板。
            this.winRound(true);
            this.wheelController.playHitShake(() => {
                if (this.roundState === RoundState.RoundWin) {
                    this.showWinPanel();
                }
            });
            return;
        }

        // 飞刀命中轮盘时增加“急促上下微抖动”反馈，强化打击感。
        // 使用轮盘本体抖动，已附着飞刀作为其子节点会同步抖动，视觉上更自然。
        this.wheelController.playHitShake();

        if (this.flyingKnives.length === 0) {
            this.roundState = RoundState.Idle;
        }
    }

    private showWinPanel() {
        if (this.winPanel) {
            this.winPanel.active = true;
        }
    }

    private winRound(waitForCurrentShake = false) {
        this.roundState = RoundState.RoundWin;
        for (const knife of this.flyingKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.flyingKnives.length = 0;
        if (this.currentKnife && this.currentKnife.isValid) {
            this.currentKnife.destroy();
        }
        this.currentKnife = null;
        if (!waitForCurrentShake) {
            // 非命中抖动触发的胜利结算，仍然先停抖动并归位，再展示 UI。
            this.wheelController?.resetWheelToBasePosition(true);
            this.showWinPanel();
        }
        this.inputLockedUntil = this.elapsedSeconds + 0.1;
    }

    private failRound(destroyCurrentKnife = true, hitAttachedKnife: Node | null = null, failedFlyingKnife: Node | null = null) {
        this.roundState = RoundState.RoundFail;

        const failFocusKnives = [failedFlyingKnife, hitAttachedKnife].filter(
            (knife): knife is Node => !!knife && knife.isValid,
        );

        // 先把碰撞飞刀挂到 middle，再归位轮盘；否则轮盘位移/缩放与新飞刀不在同一层级树，特写会不同步。
        if (failFocusKnives.length > 0) {
            this.wheelController?.prepareFailFocusKnives(failFocusKnives);
        }

        // 失败结算同样先归位，避免在抖动中定格导致轮盘停在中间偏移位置。
        if (failFocusKnives.length > 0) {
            // 失败特写前保留水平位置，只复位抖动与缩放，避免归位瞬间跳帧。
            this.wheelController?.stopTweensAndResetForFailFocus();
        } else {
            this.wheelController?.stopTweensAndResetTransform();
        }

        // 失败分两类：
        // 1) 撞老飞刀失败：保留新飞刀（destroyCurrentKnife = false）；
        // 2) 其它失败（越界/异常）：清理新飞刀（destroyCurrentKnife = true）。
        if (destroyCurrentKnife) {
            if (this.currentKnife && this.currentKnife.isValid) {
                this.currentKnife.destroy();
            }
            for (const knife of this.flyingKnives) {
                if (knife && knife.isValid) {
                    knife.destroy();
                }
            }
            this.flyingKnives.length = 0;
        }

        // 当需要“失败瞬间保留失误飞刀”时，把它登记到 failedDisplayKnives，
        // 这样玩家能看到失误反馈，同时又能保证下一局开始时被统一清理。
        if (!destroyCurrentKnife && failedFlyingKnife && failedFlyingKnife.isValid) {
            this.failedDisplayKnives.push(failedFlyingKnife);

            // 失败画面阶段不再需要该飞刀参与碰撞，先禁用其 Collider2D，
            // 避免后续界面动画或误触发导致额外碰撞计算。
            const knifeCollider = this.getKnifeCollider(failedFlyingKnife);
            if (knifeCollider) {
                knifeCollider.enabled = false;
            }
        }

        for (const knife of this.flyingKnives) {
            if (knife && knife.isValid) {
                knife.destroy();
            }
        }
        this.flyingKnives.length = 0;

        if (this.currentKnife && this.currentKnife.isValid) {
            this.currentKnife.destroy();
        }
        this.currentKnife = null;

        if (failedFlyingKnife) {
            // 撞飞刀失败时不立刻弹失败面板：
            // 先播放慢动作特写和红色闪烁，让玩家明确看到是哪两把飞刀发生碰撞。
            this.inputLockedUntil = this.elapsedSeconds + this.failFocusDuration + 0.1;
            if (!this.wheelController) {
                this.showFailPanel();
                return;
            }
            this.wheelController.playFailFocusEffect(
                failFocusKnives,
                this.failFocusDuration,
                this.failFocusScale,
                this.failKnifeBlinkInterval,
                () => {
                    if (this.roundState === RoundState.RoundFail) {
                        this.showFailPanel();
                    }
                },
            );
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
