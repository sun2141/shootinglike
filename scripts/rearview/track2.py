import cv2, numpy as np, sys, json
# track2.py video guide.json out.json R  ; guide = [[frame,x,y],...] rough path; detect white moving blob near interpolated guide
v,g,o=sys.argv[1],json.load(open(sys.argv[2])),sys.argv[3]; R=int(sys.argv[4])
g=np.array(g,float); F=range(int(g[0,0]),int(g[-1,0])+1)
cap=cv2.VideoCapture(v); fr={};ts={}; i=0
lo,hi=min(F)-4,max(F)+4
while True:
    ok,f=cap.read()
    if not ok or i>hi: break
    if i>=lo: fr[i]=f; ts[i]=cap.get(cv2.CAP_PROP_POS_MSEC)/1000
    i+=1
out=[]
for i in F:
    gx=np.interp(i,g[:,0],g[:,1]); gy=np.interp(i,g[:,0],g[:,2])
    x0,y0=int(gx-R),int(gy-R); x1,y1=int(gx+R),int(gy+R)
    c=fr[i][y0:y1,x0:x1].astype(np.int16)
    gray=c.mean(2); sat=c.max(2)-c.min(2)
    mot=np.minimum(np.abs(c-fr[i-3][y0:y1,x0:x1]).max(2),np.abs(c-fr[i+3][y0:y1,x0:x1]).max(2))
    m=((mot>30)&(gray>150)&(sat<70)).astype(np.uint8)
    n,lab,st,cen=cv2.connectedComponentsWithStats(m)
    best=None
    for k in range(1,n):
        if st[k,4]<4: continue
        bx,by=cen[k][0]+x0,cen[k][1]+y0; d=np.hypot(bx-gx,by-gy)
        sc=d-0.5*np.sqrt(st[k,4])
        if best is None or sc<best[0]: best=(sc,bx,by,int(st[k,2]),int(st[k,3]),int(st[k,4]))
    out.append([i,ts[i]]+([round(best[1],1),round(best[2],1),best[3],best[4],best[5]] if best else [None]*5))
json.dump(out,open(o,'w'))
for r in out: print(r)
