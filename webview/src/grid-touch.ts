/** A touch remains a tap/long press only while its original pointer stays still. */
export class GridTouchGesture {
    private active?: { id: number; x: number; y: number; started: number; held: boolean };
    begin(id: number, x: number, y: number, now: number, primary = true) {
        if (!primary || this.active) { this.cancel(); return false; }
        this.active = { id, x, y, started: now, held: false };
        return true;
    }
    move(id: number, x: number, y: number) {
        if (this.active?.id === id && Math.hypot(x - this.active.x, y - this.active.y) > 10) this.cancel();
    }
    hold(now: number) {
        if (!this.active || this.active.held || now - this.active.started < 550) return false;
        this.active.held = true;
        return true;
    }
    end(id: number) {
        if (this.active?.id !== id) return false;
        const tap = !this.active.held;
        this.cancel();
        return tap;
    }
    cancel() { this.active = undefined; }
}
