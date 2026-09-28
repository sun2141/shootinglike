import sys
from field import *
from scipy.optimize import least_squares
import pickle
obj=np.array([[-3.72,0,0],[3.72,0,0],[3.72,0,2.50],[-3.72,0,2.50]])
heights=[((1158,644),(1158,493),1.75),((1290,597.7),(1290,512.3),1.75),((550,752.4),(555,418.6),1.845)]
def unpack(p):
    f=p[0]; R,_=cv2.Rodrigues(p[1:4]); t=p[4:7]; lam=p[7]; return f,R,t,lam
def res(p,wg=1.0,wf=1.0,wh=1.0):
    f,R,t,lam=unpack(p); C=-R.T@t
    rg=(proj(f,R,t,obj)-goal_img).ravel()*wg
    def ground(P):
        d=(R.T@np.c_[(P[:,0]-cx)/f,(P[:,1]-cy)/f,np.ones(len(P))].T).T; s=-C[2]/d[:,2]; return C+s[:,None]*d
    Pp=ground(pen); Pa=ground(arc)
    rf=np.r_[(Pp[:,1]+16.5*lam)/0.15,(np.hypot(Pa[:,0],Pa[:,1]+11*lam)-9.15*lam)/0.15]*wf/np.sqrt(len(pen)+len(arc))*4
    rh=[]
    for b,tp,H in heights:
        P=ground(np.array([b]))[0]; pt=proj(f,R,t,(P+[0,0,H])[None])[0]; rh.append((pt[1]-tp[1])/2.0)
    return np.r_[rg,rf,np.array(rh)*wh]
R0,t0,C0,e0=pose(1500,7.44,2.50); rv0,_=cv2.Rodrigues(R0)
for label,kw in [('goal+field+heights',{}),('goal+heights only',dict(wf=0.0)),('goal+field only',dict(wh=0.0))]:
    r=least_squares(lambda p: res(p,**kw),np.r_[1500,rv0.ravel(),t0,1.0])
    f,R,t,lam=unpack(r.x); C=-R.T@t
    rr=res(r.x,wg=1,wf=1,wh=1)
    print(f"{label:22s} f={f:7.1f} lam={lam:.3f} camH={C[2]:.2f} goal rms={np.sqrt((rr[:8]**2).mean()):.2f}px heights(px)={(rr[-3:]*2).round(1)} field(scaled)={np.sqrt((rr[8:-3]**2).mean()):.2f}")
    if label.startswith('goal+field+'): pickle.dump(dict(f=f,R=R,t=t,C=C,lam=lam),open('jointpose2.pkl','wb'))
