import expo.modules.sharing.ShareIntentQueue;

public final class ShareIntentQueueTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  public static void main(String[] args) {
    ShareIntentQueue<String> q = new ShareIntentQueue<>(2);
    check(q.offer("same"), "first accepted");
    String first = q.peek().generation;
    check(q.offer("same"), "identical second accepted");
    check(!q.offer("overflow"), "queue is bounded");
    check(q.takeRejectedWhenEmpty() == 0, "report overflow after handling queued shares");
    check(!q.acknowledge("bad"), "wrong generation cannot clear first");
    check(q.acknowledge(first), "first acknowledged");
    String second = q.peek().generation;
    check(!first.equals(second), "identical shares get distinct generations");
    check(!q.acknowledge(first), "old completion cannot clear identical newer share");
    check(q.peek().payload.equals("same"), "second share remains queued");
    check(q.acknowledge(second), "second acknowledged");
    check(q.takeRejectedWhenEmpty() == 1, "overflow is reported once");
    check(q.takeRejectedWhenEmpty() == 0, "overflow acknowledgement is idempotent");
    System.out.println("PASS native share queue preserves identical overlapping intents and reports overflow");
  }
}
