import expo.modules.audioprocessormodule.PcmIntegrity;
import java.io.*;
import java.util.*;

public class TrimSegmentsTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static byte[] constant(int count, int sample) {
        byte[] data = new byte[count * 2];
        for (int i=0;i<count;i++) { data[2*i]=(byte)sample; data[2*i+1]=(byte)(sample >> 8); }
        return data;
    }
    static int sample(byte[] data, int index) { return (short)((data[index*2]&255) | ((data[index*2+1]&255)<<8)); }
    static byte[] copy(byte[] in, long[] starts, long[] ends, int rate) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        PcmIntegrity.copyTrimmedSegments(new ByteArrayInputStream(in),out,starts,ends,in.length/2,rate);
        return out.toByteArray();
    }
    public static void main(String[] args) throws Exception {
        byte[] raw = constant(2400,20000);
        check(Arrays.equals(copy(raw,new long[]{0},new long[]{2399},48000),raw), "untrimmed samples changed");
        byte[] one=copy(raw,new long[]{200},new long[]{1199},48000);
        check(one.length==2000 && sample(one,0)==0 && sample(one,999)==0, "single segment outer cuts");
        check(sample(one,239)==20000 && sample(one,500)==20000 && sample(one,760)==20000, "fade middle");
        byte[] leading=copy(raw,new long[]{200},new long[]{2399},48000);
        check(sample(leading,0)==0 && sample(leading,2199)==20000, "leading-only cut");
        byte[] trailing=copy(raw,new long[]{0},new long[]{999},48000);
        check(sample(trailing,0)==20000 && sample(trailing,999)==0, "trailing-only cut");
        byte[] multi=copy(raw,new long[]{200,1400},new long[]{799,1999},48000);
        check(multi.length==2400 && sample(multi,0)==0 && sample(multi,599)==0 && sample(multi,600)==0 && sample(multi,1199)==0, "outer and inner cuts");
        byte[] adjacent=copy(raw,new long[]{0,1200},new long[]{1199,2399},48000);
        check(Arrays.equals(adjacent,raw), "adjacent ranges are not cuts");
        for(int len:new int[]{1,2,3,10,100,239,240,241,479}) {
            byte[] shortOut=copy(raw,new long[]{100},new long[]{100+len-1},48000);
            check(shortOut.length==len*2 && sample(shortOut,0)==0 && sample(shortOut,len-1)==0, "short two-sided fade "+len);
            for(int i=0;i<len;i++) check(sample(shortOut,i)>=0 && sample(shortOut,i)<=20000, "short gain "+len);
        }
        try { copy(raw,new long[]{100,90},new long[]{200,300},48000); throw new AssertionError("overlap accepted"); } catch(IOException expected) {}
        try { PcmIntegrity.copyTrimmedSegments(new ByteArrayInputStream(new byte[2]),new ByteArrayOutputStream(),new long[]{0},new long[]{9},10,48000); throw new AssertionError("short read accepted"); } catch(EOFException expected) {}
        System.out.println("PASS actual PCM trim handles single/multiple, outer/inner/short cuts and exact untrimmed bytes");
    }
}
