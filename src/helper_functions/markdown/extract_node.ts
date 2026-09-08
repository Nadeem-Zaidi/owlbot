export function extractNode(node: any): string {
    if (node.type === "text") {
        return node.value;
    }
    if (node.type === "inlineCode") {
        return node.value;
    }
    if (!node.children) {
        return "";
    }
    return node.children.map((child: any) => extractNode(child)).join("");
}