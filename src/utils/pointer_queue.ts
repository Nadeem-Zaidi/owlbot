class PointerQueue<T>{
    private items:(T|undefined)[]=[];
    private head=0;

    enqueue(item:T){
        this.items.push(item);
    }

    dequeue() : T| undefined{
        if(this.head >= this.items.length) return undefined;
        const item=this.items[this.head];
        this.items[this.head]=undefined;
        this.head++;

        if(this.head >1024 && this.head > this.items.length >>1){
            this.items=this.items.splice(this.head);
            this.head=0;
        }
        return item;
    }

    get size():number{
        return this.items.length-this.head;

    }

    get empty():boolean{
        return this.head >=this.items.length;

    }
}